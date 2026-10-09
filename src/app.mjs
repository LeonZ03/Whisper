import { ready, b64, unb64, wipe, deriveCredentials, unlockIdentity, encryptMessage, decryptMessage, safetyCode } from './crypto.mjs';
import { MessageLifecycle, dissolveViewOnceImage } from './message-lifecycle.mjs';
import { createAccountSessionsUI } from './account-sessions-ui.mjs';
import { createWebAccountUI } from './web-account-ui.mjs';
import { createWebLoginStore } from './web-login-store.mjs';
import { accountUI } from './account-ui.mjs';
import { prepareEnrollment, validateNewPassword } from './account-client.mjs';
import { requestAPI as api } from './api-transport.mjs';
import { RealtimeConnection } from './realtime-client.mjs';
import { SendQueue } from './send-queue.mjs';
const $ = (id) => document.getElementById(id);
const android = Boolean(globalThis.whisperAndroidRequest);
const webLoginStore = android ? null : createWebLoginStore();
let webPaused = false, authAttempt = 0;
const loginChannel = !android && globalThis.BroadcastChannel ? new BroadcastChannel('whisper-login-control-v1') : null;
if (loginChannel) loginChannel.onmessage = event => { if (event.data === 'logout') lock({ broadcast: false }); };
function mobileView(view) {
  if (!android) return;
  $('chat-screen').dataset.view = view;
  $('my-panel').hidden = view !== 'my';
  $('device-history-panel').hidden = view !== 'devices';
  $('admin-panel').hidden = view !== 'admin';
  $('chat-body').hidden = ['my', 'admin', 'devices'].includes(view);
  $('chat-screen').querySelector('.app-header').hidden = ['chat', 'my', 'devices'].includes(view);
  $('mobile-nav').hidden = view === 'chat' || view === 'devices';
  for (const name of ['conversations', 'my']) {
    $(`nav-${name}`).classList.toggle('active', name === view);
    $(`nav-${name}`).setAttribute('aria-current', name === view ? 'page' : 'false');
  }
}
for (const label of document.querySelectorAll('[data-app-version]')) label.textContent = `v${__APP_VERSION__}`;
let self = null, selected = null, conversations = [], messages = [], mode = 'login';
let syncing = false, generation = 0, toastTimer, signature = '', imageTimer, imageUrl, viewingId, safetyPeer;
globalThis.whisperRequestGeneration = () => generation;
let blocked = false, sending = false;
let cloudMode = false, pollIntervalMs = 1500, nextPollAt = 0;
let realtimeSupported = false, realtime = null, syncCursor = null, deltaTask = null, deltaPending = false, pollTimer;
let suspendedReading = null;
let androidPaused = false;
let restoringLogin = false, savedLoginPending = false;
let cancelImageDissolve = null;
const messageCards = new Map();
const sendPreviews = new Map();
const sendQueue = new SendQueue({
  send: async (message, context) => {
    if (context.user !== self || context.generation !== generation || selected?.id !== context.conversationId || blocked || selected.peer.publicKey !== context.peerKey) throw Object.assign(Error('会话已变化，发送已取消。'), { name: 'AbortError' });
    await api(`/api/conversations/${context.conversationId}/messages`, 'POST', message);
  },
  onState: (message, context, state) => {
    if (context.user !== self || context.generation !== generation) return;
    const preview = sendPreviews.get(message.id);
    if (state === 'cancelled') { removeSendPreview(message.id); return; }
    if (preview && state !== 'failed') preview.status.textContent = state === 'queued' ? '排队中…' : state === 'sending' ? '发送中…' : '已发送，正在同步';
    checkTrust();
  },
});
const lifecycle = new MessageLifecycle($('messages'), (id) => {
  messageCards.delete(id); messages = messages.filter((m) => m.id !== id);
  if (viewingId === id) closeImage(true);
});
function clearMessageView() { sendQueue.cancel(); lifecycle.clear(); messageCards.clear(); for (const preview of sendPreviews.values()) clearTimeout(preview.timer); sendPreviews.clear(); messages = []; signature = ''; }
function suspendMessageView() {
  suspendedReading = { top: $('messages').scrollTop, focused: document.activeElement === $('message-input') };
  const encrypted = messages, shells = [...messageCards];
  for (const [, card] of shells) card.element.replaceChildren();
  clearMessageView(); messages = encrypted;
  for (const [id, card] of shells) { card.key = ''; messageCards.set(id, card); $('messages').append(card.element); }
}
function stopRealtime() { realtime?.stop(); realtime = null; }
function startRealtime() {
  if (!realtimeSupported || self?.role !== 'member' || self.mustChangePassword || androidPaused || webPaused || document.hidden || navigator.onLine === false) return;
  if (realtime) { realtime.start(); return; }
  const url = android ? 'wss://whisper.leonz03.dpdns.org/api/realtime' : new URL('/api/realtime', location.href);
  if (!android) url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  realtime = new RealtimeConnection({ request: api, url: String(url), onChange: () => sync(),
    onState: state => { if (self) connection(state === 'open'); } });
  realtime.start();
}
const pins = () => {
  try {
    const key = `whisper:public-key-pins:${self.id}:${self.publicKey}`;
    const scoped = localStorage.getItem(key);
    if (scoped !== null) return JSON.parse(scoped);
    // Preserve legacy peer keys after the scope gains our identity public key.
    // Reverification is required because a forgotten-password reset changes it.
    const legacy = JSON.parse(localStorage.getItem(`whisper:public-key-pins:${self.id}`) || '{}');
    const migrated = Object.fromEntries(Object.entries(legacy).map(([id, pin]) => [id, { ...pin, verified: false }]));
    localStorage.setItem(key, JSON.stringify(migrated)); return migrated;
  } catch { return {}; }
};
function savePin(peer, verified = false, replaceAfterVerification = false) {
  const data = pins(); data[peer.id] = { publicKey: peer.publicKey, verified };
  const prior = pins()[peer.id];
  if (prior?.publicKey !== peer.publicKey && prior && replaceAfterVerification) {
    data[peer.id].previous = [...(prior.previous || []), prior.publicKey].slice(-8);
  }
  try { localStorage.setItem(`whisper:public-key-pins:${self.id}:${self.publicKey}`, JSON.stringify(data)); }
  catch { toast('浏览器禁止本地存储，安全码核对状态无法保存。'); }
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function showSendPreview(id, text, expiresAt) {
  const box = $('messages'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  box.querySelector('.messages-empty')?.remove();
  const article = document.createElement('article'); article.className = 'message own sending-preview';
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
  const status = document.createElement('small'); status.className = 'message-meta'; status.setAttribute('role', 'status'); status.textContent = '发送中…';
  article.append(bubble, status); box.append(article); if (atBottom) box.scrollTop = box.scrollHeight;
  const timer = setTimeout(() => removeSendPreview(id), Math.max(0, expiresAt - Date.now()));
  sendPreviews.set(id, { article, bubble, status, timer });
}
function removeSendPreview(id) {
  const preview = sendPreviews.get(id); if (!preview) return;
  clearTimeout(preview.timer); preview.article.replaceChildren(); preview.article.remove(); sendPreviews.delete(id);
}
function setMode(next) {
  mode = next; $('register-fields').hidden = mode !== 'register';
  $('activation-field').hidden = mode !== 'login' || $('username').value.trim().toLowerCase() !== 'root';
  $('password').minLength = 1;
  $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('password').placeholder = mode === 'register' ? '新密码：1–12 个字符' : '请输入完整密码（旧长密码仍可登录）';
  $('auth-title').textContent = mode === 'register' ? '申请一个账号' : '回到你的会话';
  $('auth-subtitle').textContent = mode === 'register' ? '管理员批准后才能登录。身份密钥将在你的浏览器生成。' : '使用用户名和密码登录，并在本机解锁密钥。';
  if (android) {
    $('auth-subtitle').textContent = mode === 'register' ? '账号申请获批后即可登录。' : '与网页、CLI 共用云端账号';
    $('password').placeholder = mode === 'register' ? '新密码：1–12 个字符' : '请输入密码';
  }
  $('auth-submit').textContent = mode === 'register' ? '提交申请' : '解锁并进入';
  $('auth-error').textContent = '';
  for (const item of ['login', 'register']) { $(`${item}-tab`).classList.toggle('active', item === mode); $(`${item}-tab`).setAttribute('aria-selected', String(item === mode)); }
}
$('login-tab').onclick = () => setMode('login'); $('register-tab').onclick = () => setMode('register');
$('username').addEventListener('input', () => { $('activation-field').hidden = mode !== 'login' || $('username').value.trim().toLowerCase() !== 'root'; });
$('open-recovery').onclick = () => { $('recovery-form').hidden = !$('recovery-form').hidden; $('recovery-error').textContent = ''; };
$('recovery-form').onsubmit = async event => {
  event.preventDefault(); const form = $('recovery-form'); const submit = form.querySelector('button[type="submit"]');
  const username = $('recovery-name').value.trim().toLowerCase(); const recoveryCode = $('recovery-code').value;
  let password = $('recovery-password').value, identity;
  $('recovery-error').textContent = ''; submit.disabled = true;
  try {
    if (password !== $('recovery-repeat').value) throw Error('两次新密码不一致。');
    validateNewPassword(password);
    identity = await prepareEnrollment(password);
    await api('/api/auth/recover', 'POST', { username, recoveryCode, ...identity });
    await webLoginStore?.clear();
    toast('新身份已设置。请重新登录，并与联系人通过可信渠道核对新安全码。');
    form.hidden = true; setMode('login'); $('username').value = username;
  } catch (error) { $('recovery-error').textContent = error.message; }
  finally { password = ''; for (const id of ['recovery-code','recovery-password','recovery-repeat']) $(id).value = ''; submit.disabled = false; }
};
$('auth-form').onsubmit = async (event) => {
  event.preventDefault(); if ($('auth-submit').disabled) return;
  const attempt = ++authAttempt;
  const checkAttempt = () => { if (attempt !== authAttempt || webPaused || androidPaused) throw Error('登录已取消。'); };
  if (savedLoginPending) { generation++; savedLoginPending = false; if (android) globalThis.whisperAndroidClearSession(); else await webLoginStore.clear(); hideRestoreNotice(); }
  const username = $('username').value.trim().toLowerCase(); let password = $('password').value;
  const currentMode = mode; const activationCode = $('activation-code').value; let credentials, secretKey, issued = false;
  $('auth-submit').disabled = true; $('login-tab').disabled = true; $('register-tab').disabled = true;
  $('auth-submit').textContent = '正在解锁本机密钥…'; $('auth-error').textContent = '';
  try {
    if (currentMode === 'register') validateNewPassword(password);
    if (currentMode === 'register') {
      const payload = await prepareEnrollment(password, $('request-note').value);
      await api('/api/auth/register', 'POST', { username, ...payload });
      $('request-note').value = ''; $('password').value = '';
      setMode('login'); toast('申请已提交，请等待管理员审批后登录。'); return;
    }
    const salt = (await api('/api/auth/salt?username=' + encodeURIComponent(username))).salt;
    checkAttempt(); credentials = await deriveCredentials(password, salt); password = ''; $('password').value = ''; checkAttempt();
    const persistent = android || await webLoginStore.available(); checkAttempt();
    let user;
    user = await api('/api/auth/login', 'POST', { username, authKey: b64(credentials.authKey), activationCode, persistent }); issued = true; checkAttempt();
    secretKey = unlockIdentity(user, credentials.vaultKey);
    if (!android && persistent && !user.mustChangePassword) {
      await webLoginStore.save({ v: 1, id: user.id, username: user.username, publicKey: user.publicKey, secretKey: b64(secretKey) }); checkAttempt();
    }
    await enterUser(user, secretKey, activationCode, true);
    if (!persistent) toast('浏览器无法保护保存登录，关闭页面后需重新登录。');
  } catch (error) {
    if (!self && issued && attempt === authAttempt) { await webLoginStore?.clear().catch(() => {}); await api('/api/auth/logout', 'POST').catch(() => {}); }
    if (!self) wipe(secretKey); $('auth-error').textContent = error.message;
  } finally {
    password = ''; wipe(credentials?.authKey); wipe(credentials?.vaultKey);
    $('auth-submit').disabled = false; $('login-tab').disabled = false; $('register-tab').disabled = false;
    $('auth-submit').textContent = mode === 'register' ? '提交申请' : '解锁并进入';
  }
};
async function enterUser(user, secretKey, activationCode = '', save = false) {
  stopRealtime(); syncCursor = null; suspendedReading = null;
  self = { id: user.id, username: user.username, publicKey: user.publicKey, secretKey, role: user.role, mustChangePassword: user.mustChangePassword, activationCode: user.mustChangePassword ? activationCode : '' };
  generation++; $('auth-screen').hidden = true; $('chat-screen').hidden = false; hideRestoreNotice();
  $('self-name').textContent = '@' + self.username;
  if (android) {
    $('my-name').textContent = self.username; $('my-avatar').textContent = self.username[0].toUpperCase();
    $('my-role').textContent = self.role === 'root' ? '云端管理员' : '云端账号';
    $('nav-conversations').querySelector('span').textContent = self.role === 'root' ? '管理' : '会话';
    mobileView(self.role === 'root' ? 'admin' : 'conversations');
    const current = self;
    if (save && !self.mustChangePassword && !await globalThis.whisperAndroidSaveLogin({ v: 1, id: self.id, username: self.username, publicKey: self.publicKey, secretKey: b64(secretKey) }))
      toast('无法保存登录状态，请检查手机存储空间后重新登录。');
    if (self !== current) return;
  }
  $('entry-kind').textContent = cloudMode ? '云端服务' : location.hostname.endsWith('.trycloudflare.com') ? '临时链接入口' : '本机入口';
  $('activation-code').value = ''; selected = null; conversations = []; messages = []; signature = ''; renderConversations();
  $('empty-state').hidden = false; $('conversation-panel').hidden = true;
  await accountControls.enter(self);
  webAccountUI?.enter(self);
  if (self?.role === 'member') await sync();
  startRealtime();
}
function hideRestoreNotice() {
  $('login-restore-status')?.remove(); $('retry-login')?.remove(); $('restore-logout')?.remove();
  if ($('web-startup')) $('web-startup').hidden = true;
  $('chat-screen').removeAttribute('aria-busy'); $('new-chat-form').inert = false;
  if ($('web-nav')) $('web-nav').inert = false;
  if (android) {
    $('startup-screen').hidden = true; $('chat-screen').removeAttribute('aria-busy');
    $('new-chat-form').inert = false; $('mobile-nav').inert = false;
  }
}
function restoreNotice(text, retryable = false) {
  hideRestoreNotice();
  $('auth-screen').hidden = true; $('chat-screen').hidden = false; mobileView('conversations');
  $('chat-screen').setAttribute('aria-busy', String(!retryable));
  $('new-chat-form').inert = true; if ($('mobile-nav')) $('mobile-nav').inert = true;
  if ($('web-nav')) $('web-nav').inert = true;
  const status = document.createElement('p'); status.id = 'login-restore-status'; status.className = 'field-help'; status.setAttribute('role', 'status'); status.textContent = text;
  $('conversations').before(status);
  if (retryable) {
    const retry = document.createElement('button'); retry.id = 'retry-login'; retry.type = 'button'; retry.className = 'quiet'; retry.textContent = '重试连接'; retry.onclick = () => void restoreSavedLogin();
    const logout = document.createElement('button'); logout.id = 'restore-logout'; logout.type = 'button'; logout.className = 'quiet'; logout.textContent = '退出登录'; logout.onclick = () => $('logout').click();
    $('conversations').before(retry, logout);
  }
}
async function restoreSavedLogin() {
  if (self || restoringLogin || androidPaused || webPaused) return;
  let key, saved; const epoch = generation; restoringLogin = true;
  try {
    try { saved = android ? await globalThis.whisperAndroidRestoreLogin() : await webLoginStore.load(); }
    catch { throw Object.assign(Error('保存的登录不可读取'), { status: 401 }); }
    if (epoch !== generation) return;
    if (!saved) { savedLoginPending = false; hideRestoreNotice(); $('chat-screen').hidden = true; $('auth-screen').hidden = false; return; }
    savedLoginPending = true; $('auth-submit').disabled = true; $('auth-submit').textContent = '正在恢复登录…';
    if (saved.v !== 1 || typeof saved.id !== 'string' || typeof saved.publicKey !== 'string' || typeof saved.secretKey !== 'string') throw Object.assign(Error('保存的身份无效'), { status: 401 });
    key = unb64(saved.secretKey); if (key.length !== 32) throw Object.assign(Error('保存的身份无效'), { status: 401 });
    restoreNotice('正在同步会话…');
    const me = await api('/api/account/me');
    if (epoch !== generation || androidPaused || webPaused) return;
    if (me.id !== saved.id || me.publicKey !== saved.publicKey || me.mustChangePassword) throw Object.assign(Error('账号状态已变化'), { status: 401 });
    savedLoginPending = false; const sessionKey = key; key = null; await enterUser(me, sessionKey);
  } catch (error) {
    if (epoch !== generation) return;
    if (error.status === 401 || error.status === 403) { lock(); toast('登录已撤销或账号已变化，请重新登录。'); }
    else { savedLoginPending = true; restoreNotice('暂时无法连接，已保留登录状态。联网后会自动同步。', true); }
  } finally {
    wipe(key); saved = null; restoringLogin = false;
    $('auth-submit').disabled = false; $('auth-submit').textContent = mode === 'register' ? '提交申请' : '解锁并进入';
    if (savedLoginPending && epoch !== generation && !androidPaused && !webPaused) void restoreSavedLogin();
  }
}
function lock({ keepSaved = false, broadcast = true } = {}) {
  stopRealtime(); syncCursor = null; deltaPending = false; suspendedReading = null;
  authAttempt++;
  // Closing a page preserves a seal already being written for the login that
  // just succeeded. Explicit logout still cancels and clears queued writes.
  if (!keepSaved) webLoginStore?.cancel();
  if (!android && !keepSaved) {
    void webLoginStore.clear().catch(() => toast('浏览器未能清除登录存储，请清除此站点数据。'));
    if (broadcast) loginChannel?.postMessage('logout');
  }
  savedLoginPending = false; hideRestoreNotice();
  generation++; wipe(self?.secretKey); self = null; selected = null; conversations = []; messages = []; signature = '';
  accountControls.clear();
  webAccountUI?.clear();
  sessionsUI?.clear();
  closeImage(); $('safety-dialog').close(); $('message-input').value = ''; $('password').value = ''; $('activation-code').value = '';
  clearMessageView(); $('conversations').replaceChildren(); $('safety-code').textContent = '';
  $('chat-screen').hidden = true; $('auth-screen').hidden = false;
  if (android) {
    globalThis.whisperAndroidClearSession(); mobileView('conversations');
    $('my-name').textContent = ''; $('my-avatar').textContent = ''; $('privacy-dialog').close();
    $('chat-options').close();
    for (const input of document.querySelectorAll('input[type="password"]')) input.value = '';
  }
}
const accountControls = accountUI({ api, getSelf: () => self, lock, toast });
const webAccountUI = !android ? createWebAccountUI({ api, getSelf: () => self, onLeaveChat: () => { closeImage(); $('safety-dialog').close(); } }) : null;
if (!android) globalThis.whisperWebSessionRevoked = () => { if (self) { lock(); toast('登录已撤销，请重新登录。'); } };
const sessionsUI = android ? createAccountSessionsUI({ root: $('device-history-list'), summary: $('current-device-name'),
  fetchImpl: async (path, options) => {
    const payload = await api(path); if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { ok: true, json: async () => payload };
  } }) : null;
if (android) $('mobile-nav').before($('admin-panel'));
$('logout').onclick = async () => {
  $('logout').disabled = true;
  // Native transport obtains the cookie from its vault. Revoke it before
  // clearing that vault; browser HttpOnly cookies survive the memory lock.
  if (!android) lock();
  else { authAttempt++; generation++; stopRealtime(); closeImage(); clearMessageView(); }
  $('auth-submit').disabled = true;
  try { await api('/api/auth/logout', 'POST'); } catch {}
  finally { if (android) lock(); $('auth-submit').disabled = false; $('logout').disabled = false; }
};
function renderConversations() {
  const fragment = document.createDocumentFragment();
  for (const c of conversations) {
    const button = document.createElement('button'); button.className = 'conversation-item' + (selected?.id === c.id ? ' selected' : '');
    button.dataset.conversationId = c.id; button.setAttribute('aria-label', '与 ' + c.peer.username + ' 的会话');
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = c.peer.username[0];
    const label = document.createElement('span'); const title = document.createElement('strong'); title.textContent = c.peer.username;
    const small = document.createElement('small'); small.textContent = '双人加密会话'; label.append(title, small); button.append(avatar, label);
    button.onclick = () => selectConversation(c); fragment.append(button);
  }
  $('conversations').replaceChildren(fragment);
}
function checkTrust() {
  if (!selected || !self) return;
  let pin = pins()[selected.peer.id]; if (!pin) { savePin(selected.peer); pin = pins()[selected.peer.id]; }
  blocked = Boolean(pin && pin.publicKey !== selected.peer.publicKey);
  const verified = !blocked && pin?.verified;
  $('trust-notice').className = 'trust-notice' + (blocked ? ' blocked' : verified ? ' verified' : '');
  $('trust-notice').textContent = blocked ? '对方身份公钥发生变化。已阻止发送与解密。请通过可信外部渠道核对新的完整安全码，再明确更新本机信任记录。' : verified ? '已在此浏览器核对安全码。请仍注意终端安全和截图风险。' : '首次会话，请通过可信渠道核对双方安全码；首次自动记住公钥不等于验证身份。';
  if (android) $('trust-notice').textContent = blocked ? '对方身份已变化，请核对新安全码后继续。' : verified ? '已核对安全码' : '首次会话，请核对安全码';
  $('verify').textContent = blocked ? '核对新身份' : verified ? '已核对安全码' : '核对安全码';
  if (blocked && sendQueue.size) sendQueue.cancel();
  $('send').disabled = blocked || sendQueue.size >= sendQueue.limit; $('image-button').disabled = blocked || sending;
}
async function selectConversation(c) {
  generation++; syncCursor = null; suspendedReading = null; closeImage(); selected = c; messages = []; signature = ''; $('message-input').value = '';
  $('empty-state').hidden = true; $('conversation-panel').hidden = false;
  $('peer-title').textContent = c.peer.username; $('peer-avatar').textContent = c.peer.username[0];
  clearMessageView(); checkTrust(); renderConversations();
  mobileView('chat');
  await refreshMessages(); if (!android) $('message-input').focus();
}
$('new-chat-form').onsubmit = async (event) => {
  event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
  try {
    const c = await api('/api/conversations', 'POST', { username: $('peer-name').value.trim().toLowerCase() });
    if (!conversations.some((x) => x.id === c.id)) conversations.unshift(c);
    $('peer-name').value = ''; await selectConversation(c);
  } catch (error) { toast(error.message); } finally { if (button) button.disabled = false; }
};
function connection(ok) { $('connection').textContent = ok ? '● 已连接' : '● 连接中断'; $('connection').classList.toggle('offline', !ok); }
async function refreshMessages(prefetched) {
  if (realtimeSupported) return sync();
  if (!self || !selected) return;
  const current = selected.id, epoch = generation;
  const result = prefetched ?? await api(`/api/conversations/${current}/messages`);
  if (!self || generation !== epoch || selected?.id !== current) return;
  for (const item of result) removeSendPreview(item.id);
  messages = result;
  if (viewingId && !messages.some((m) => m.id === viewingId)) closeImage();
  const sig = JSON.stringify(result.map((m) => [m.id, m.consumedAt, m.ciphertext, m.nonce, m.expiresAt]));
  if (sig !== signature) { signature = sig; renderMessages(); }
  connection(true);
}
async function sync(force = true) {
  if (androidPaused || webPaused) return;
  if (realtimeSupported) return force ? syncDelta() : undefined;
  if (!force && ((cloudMode && document.hidden) || Date.now() < nextPollAt)) return;
  nextPollAt = Date.now() + pollIntervalMs;
  if (!self || self.role !== 'member' || syncing) return; syncing = true; const epoch = generation;
  try {
    const [result, recentMessages] = await Promise.all([
      api('/api/conversations'),
      selected ? api(`/api/conversations/${selected.id}/messages`) : Promise.resolve(null)
    ]);
    if (!self || generation !== epoch) return;
    const listChanged = JSON.stringify(result) !== JSON.stringify(conversations); conversations = result;
    if (selected) {
      const updated = conversations.find((c) => c.id === selected.id);
      if (updated) { const keyChanged = updated.peer.publicKey !== selected.peer.publicKey; selected = updated; checkTrust(); if (keyChanged) signature = ''; }
    }
    if (listChanged) renderConversations(); await refreshMessages(recentMessages); connection(true);
  } catch (error) {
    if (!self || epoch !== generation) return;
    connection(false); clearMessageView(); signature = ''; closeImage();
    if (error.status === 401) { lock(); toast('登录已过期，请重新登录。'); }
  } finally { syncing = false; }
}
function applyDelta(result) {
  const priorList = JSON.stringify(conversations);
  const removedConversations = new Set(result.removedConversations);
  const list = new Map((result.reset ? [] : conversations).map(c => [c.id, c]));
  for (const id of removedConversations) list.delete(id);
  for (const c of result.conversations) list.set(c.id, c);
  conversations = [...list.values()].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  if (selected && result.conversationId !== selected.id) {
    closeImage(); selected = null; clearMessageView(); suspendedReading = null;
    $('conversation-panel').hidden = true; $('empty-state').hidden = false; mobileView('conversations');
  }
  if (selected) {
    const updated = conversations.find(c => c.id === selected.id);
    if (updated) {
      const keyChanged = updated.peer.publicKey !== selected.peer.publicKey;
      selected = updated; checkTrust();
      $('peer-title').textContent = selected.peer.username; $('peer-avatar').textContent = selected.peer.username[0];
      if (keyChanged) { signature = ''; closeImage(); }
    }
    const removed = new Set(result.removed);
    const merged = new Map((result.reset ? [] : messages).filter(m => !removed.has(m.id)).map(m => [m.id, m]));
    for (const item of result.messages) {
      // Synchronization never receives view-once image payloads.
      merged.set(item.id, item.type === 'image' ? { ...item, ciphertext: null, nonce: null } : item);
      removeSendPreview(item.id);
    }
    messages = [...merged.values()].filter(m => m.expiresAt > Date.now()).sort((a, b) => a.seq - b.seq);
    if (viewingId && !messages.some(m => m.id === viewingId)) closeImage();
    const sig = JSON.stringify(messages.map(m => [m.id, m.consumedAt, m.ciphertext, m.nonce, m.expiresAt, blocked]));
    if (signature !== sig) { signature = sig; renderMessages(); }
    if (suspendedReading) {
      $('messages').scrollTop = suspendedReading.top;
      if (suspendedReading.focused) $('message-input').focus({ preventScroll: true });
      suspendedReading = null;
    }
  }
  if (JSON.stringify(conversations) !== priorList) renderConversations();
}
function syncDelta() {
  if (!self || self.role !== 'member' || androidPaused || webPaused || document.hidden) return Promise.resolve();
  deltaPending = true;
  if (deltaTask) return deltaTask;
  deltaTask = (async () => {
    while (deltaPending && self && self.role === 'member' && !androidPaused && !webPaused && !document.hidden) {
      deltaPending = false;
      const epoch = generation, user = self, current = selected?.id ?? null;
      try {
        let more;
        do {
          const params = new URLSearchParams();
          if (current) params.set('conversationId', current);
          if (syncCursor !== null) params.set('cursor', String(syncCursor));
          const result = await api('/api/sync' + (params.size ? '?' + params : ''));
          if (generation !== epoch || self !== user || (selected?.id ?? null) !== current || androidPaused || webPaused || document.hidden) break;
          if (result.version !== 1 || !Number.isSafeInteger(result.cursor) || result.cursor < 0 ||
              !Array.isArray(result.conversations) || !Array.isArray(result.removedConversations) || !Array.isArray(result.messages) || !Array.isArray(result.removed)) throw Error('同步响应无效。');
          applyDelta(result);
          // Commit only after this generation successfully applied the matching data.
          syncCursor = result.conversationId !== current ? null : result.cursor; more = result.more === true;
          connection(true);
          if (selected?.id !== current && current !== null) break;
        } while (more);
      } catch (error) {
        if (generation !== epoch || self !== user) continue;
        connection(false); closeImage();
        if (error.status === 401 || error.status === 403) { lock(); toast('登录已撤销或账号已变化，请重新登录。'); }
      }
    }
  })().finally(() => { deltaTask = null; });
  return deltaTask;
}
function renderMessages() {
  const box = $('messages'); const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const oldScroll = box.scrollTop;
  messages = messages.filter((m) => m.expiresAt > Date.now());
  const present = new Set(messages.map(m => m.id));
  for (const [id, card] of messageCards) {
    if (!present.has(id) && !lifecycle.entries.has(id)) { card.element.replaceChildren(); card.element.remove(); messageCards.delete(id); }
  }
  lifecycle.reconcile(new Set(messages.map((m) => m.id)), messages.length >= 200 ? messages[0].seq : 0);
  if (messages.length) box.querySelector('.messages-empty')?.remove();
  if (!messages.length && !sendPreviews.size) lifecycle.emptyState();
  for (const m of messages) {
    const key = JSON.stringify([m.ciphertext, m.nonce, m.expiresAt, m.consumedAt, blocked]);
    const previous = messageCards.get(m.id);
    if (previous?.key === key) continue;
    const own = m.senderId === self.id; const article = previous?.element ?? document.createElement('article'); article.replaceChildren(); article.className = 'message' + (own ? ' own' : ''); article.dataset.messageId = m.id; article.dataset.seq = String(m.seq);
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    if (blocked) { bubble.textContent = '公钥变化，已阻止解密。'; }
    else if (m.type === 'text') {
      try { const payload = decryptMessage(m, self, selected.peer); bubble.textContent = payload.body; }
      catch { bubble.textContent = '无法解密：消息可能损坏、过期或身份不匹配。'; }
    } else {
      bubble.classList.add('image-card'); const title = document.createElement('strong'); title.textContent = m.consumedAt ? '▧ 图片已清理' : '▧ 阅后图片';
      const desc = document.createElement('small'); desc.textContent = m.consumedAt ? '已经打开，不能再次查看' : '仅可打开一次 · 显示 3 秒'; bubble.append(title, desc);
      if (!m.consumedAt && !own) { const open = document.createElement('button'); open.className = 'quiet'; open.textContent = '打开图片'; open.dataset.openImage = m.id; open.onclick = () => openImage(m, open); bubble.append(open); }
      else if (!m.consumedAt) { const waiting = document.createElement('small'); waiting.textContent = '等待对方查看'; bubble.append(waiting); }
    }
    const meta = document.createElement('div'); meta.className = 'message-meta'; const time = document.createElement('span'); time.textContent = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    time.title = '到期时间：' + new Date(m.expiresAt).toLocaleString(); const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'message-delete'; remove.setAttribute('aria-label', '双方删除'); remove.title = '删除这条消息';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    for (const d of ['M3 6h18', 'M9 6V4h6v2', 'M5 6l1 14h12l1-14', 'M10 10v6', 'M14 10v6']) { const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', d); icon.append(path); }
    remove.append(icon);
    remove.onclick = async () => {
      if (!confirm('删除双方在本网站中的这条消息？无法删除截图、另存或其他副本。')) return;
      try { await api('/api/messages/' + m.id, 'DELETE'); await refreshMessages(); } catch (error) { toast(error.message); }
    };
    const countdown = document.createElement('span'); countdown.className = 'message-countdown';
    countdown.setAttribute('role', 'timer'); countdown.setAttribute('aria-live', 'off');
    countdown.title = '到期即清理；动画不延长保留时间';
    if (m.consumedAt) { countdown.textContent = '已查看并清理'; countdown.classList.add('consumed'); }
    meta.append(time, countdown, remove); article.append(bubble, meta);
    if (!previous) box.append(article);
    messageCards.set(m.id, { key, element: article });
    lifecycle.track(m.id, article, m.expiresAt, countdown, Boolean(m.consumedAt));
  }
  box.scrollTop = stick ? box.scrollHeight : oldScroll;
}
$('message-form').onsubmit = (event) => {
  event.preventDefault(); if (!self || !selected || blocked || androidPaused || webPaused) return;
  const input = $('message-input'); let text = input.value.trim(); if (!text) return;
  const context = { user: self, generation, conversationId: selected.id, peerKey: selected.peer.publicKey }; let message;
  try {
    if (sendQueue.size >= sendQueue.limit) throw Error('发送队列已满，请稍等再发送。');
    message = encryptMessage(self, selected.peer, selected.id, text, { ttlMs: Number($('ttl').value) });
    showSendPreview(message.id, text, message.expiresAt);
    input.value = '';
    // Keep the composer available while encrypted envelopes upload in order.
    void sendQueue.enqueue(message, context).then(() => {
      if (context.user !== self || context.generation !== generation) return;
      void refreshMessages().catch(() => {
        const waiting = sendPreviews.get(message.id); if (waiting) waiting.status.textContent = '已发送，等待连接恢复';
      });
    }).catch(error => {
      if (context.user !== self || context.generation !== generation || error.name === 'AbortError') return;
      const preview = sendPreviews.get(message.id); if (!preview) return;
      const uncertain = !error.notSent && (!error.status || error.status >= 500);
      preview.status.textContent = uncertain ? '发送结果未确认' : '发送失败';
      preview.article.classList.add('send-failed');
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet'; restore.textContent = '放回输入框';
      restore.onclick = () => {
        if (input.value) { toast('请先处理输入框中当前的草稿。'); return; }
        if (uncertain && !confirm('请先核对聊天记录。发送结果未确认，重发可能产生重复消息。仍要放回输入框？')) return;
        input.value = preview.bubble.textContent; removeSendPreview(message.id); input.focus();
      };
      preview.status.append(' · ', restore);
      toast(uncertain ? '发送结果未确认，请同步后核对；消息未自动重发。' : error.message);
    }).finally(() => checkTrust());
  } catch (error) { if (message) removeSendPreview(message.id); toast(error.message); }
  finally { text = ''; checkTrust(); }
};
$('message-input').onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); } };
$('clear-chat').onclick = async () => {
  if (!selected || !messages.length) return;
  if (!confirm('清空双方在本网站中的已有记录？此操作不会删除对方截图或另存的内容。')) return;
  try { await api(`/api/conversations/${selected.id}/clear`, 'POST', { throughSeq: Math.max(...messages.map((m) => m.seq)) }); closeImage(); await refreshMessages(); toast('已清空服务端记录；对方联网同步后会清理页面。'); }
  catch (error) { toast(error.message); }
};
$('verify').onclick = async () => {
  if (!self || !selected) return; const user = self, peer = selected.peer; safetyPeer = peer;
  $('safety-code').textContent = await safetyCode(user, peer); if (self !== user) return;
  $('safety-explanation').textContent = blocked ? '对方公钥已变化。请通过当面或另一条可信渠道与对方核对下面的完整新安全码。核对一致后，才可更新本机信任记录；旧记录会保留。' : '当面或通过另一个可信渠道，与对方比较下面的完整安全码。两边必须一致。';
  $('mark-verified').textContent = blocked ? '已独立核对新安全码，更新信任记录' : '已经与对方核对，一致';
  $('mark-verified').disabled = false; $('safety-dialog').showModal();
};
$('close-safety').onclick = () => $('safety-dialog').close();
$('mark-verified').onclick = () => {
  if (!self || !safetyPeer || selected?.peer.id !== safetyPeer.id || selected.peer.publicKey !== safetyPeer.publicKey) return;
  if (blocked && !confirm('确认已通过可信外部渠道与对方核对完整的新安全码，且两边完全一致？这会更新本机公钥信任记录。')) return;
  savePin(safetyPeer, true, blocked); $('safety-dialog').close(); checkTrust(); void refreshMessages().catch(e => toast(e.message));
};
async function prepareImage(file) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('仅支持 JPG、PNG、WebP、GIF 图片。');
  if (file.size > 20 * 1024 * 1024) throw new Error('请选择小于 20 MB 的图片。');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片分辨率过大。');
    const canvas = document.createElement('canvas');
    try {
      for (const [edge, quality] of [[1600, 0.82], [1400, 0.74], [1200, 0.68], [1000, 0.62], [800, 0.55]]) {
        const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法处理这张图片。');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob && blob.size <= 1_000_000) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
      }
      throw new Error('压缩后仍超过 1 MB，请选择分辨率更低的图片。');
    } finally { canvas.width = canvas.height = 0; }
  } finally { bitmap.close(); }
}
$('image-button').onclick = () => { if (!blocked && !sending) $('image-input').click(); };
$('image-input').onchange = async () => {
  const file = $('image-input').files[0]; $('image-input').value = '';
  if (!file || !self || !selected || blocked || sending) return;
  if (!confirm('发送一次查看图片？对方打开后显示 3 秒，未打开最多保留 24 小时；无法阻止截图。GIF 将转换为静态图片。')) return;
  const c = selected, user = self; sending = true; checkTrust(); let prepared;
  try {
    prepared = await prepareImage(file); if (self !== user) return;
    const message = encryptMessage(user, c.peer, c.id, b64(prepared.bytes), { type: 'image', ttlMs: Math.min(Number($('ttl').value), 86400000), mime: prepared.mime });
    await api(`/api/conversations/${c.id}/messages`, 'POST', message); if (selected?.id === c.id) await refreshMessages(); toast('图片已在本机压缩、加密并发送。');
  } catch (error) { toast(error.message); } finally { wipe(prepared?.bytes); sending = false; checkTrust(); }
};
async function openImage(m, button) {
  if (!self || !selected || blocked || viewingId) return;
  if (!confirm('现在打开？关闭、切换标签页或 3 秒后将无法再次查看。网络中断也可能导致图片失效。')) return;
  const user = self, peer = selected.peer, c = selected.id; button.disabled = true;
  try {
    const envelope = await api('/api/messages/' + m.id + '/open', 'POST');
    if (self !== user || selected?.id !== c || androidPaused) return;
    const payload = decryptMessage(envelope, user, peer);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(payload.mime)) throw new Error('图片格式无效。');
    const bytes = unb64(payload.body); imageUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mime })); wipe(bytes);
    viewingId = m.id; $('view-image').alt = '阅后图片'; $('view-image').src = imageUrl;
    await $('view-image').decode();
    if (self !== user || selected?.id !== c || viewingId !== m.id || m.expiresAt <= Date.now()) { closeImage(); return; }
    $('image-dialog').showModal();
    const deadline = Math.min(Date.now() + 3_000, m.expiresAt);
    const tick = () => { const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); $('image-countdown').textContent = `${seconds} 秒后关闭`; if (!seconds) closeImage(true); };
    tick(); imageTimer = setInterval(tick, 200); await refreshMessages();
  } catch (error) { closeImage(); toast(error.message); await refreshMessages().catch(() => {}); }
  finally { button.disabled = false; }
}
function closeImage(animate = false) {
  clearInterval(imageTimer); imageTimer = null;
  cancelImageDissolve?.(); cancelImageDissolve = null;
  const image = $('view-image'), dialog = $('image-dialog'); const visible = dialog.open && Boolean(imageUrl);
  image.removeAttribute('src'); image.removeAttribute('srcset');
  if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; viewingId = null;
  if (animate === true && visible && !androidPaused && !document.hidden) {
    $('image-countdown').textContent = '图片已销毁';
    cancelImageDissolve = dissolveViewOnceImage(image, { onComplete: () => { cancelImageDissolve = null; dialog.close(); } });
  } else { image.hidden = false; dialog.close(); }
}
$('close-image').onclick = () => closeImage(true); $('image-dialog').addEventListener('cancel', () => closeImage());
if (android) {
  const leaveChat = (view) => {
    generation++; syncCursor = null; suspendedReading = null; closeImage(); $('safety-dialog').close(); selected = null; clearMessageView();
    $('message-input').value = ''; $('conversation-panel').hidden = true; $('empty-state').hidden = false;
    mobileView(view); renderConversations();
  };
  $('chat-back').onclick = () => leaveChat('conversations');
  $('nav-conversations').onclick = () => leaveChat(self?.role === 'root' ? 'admin' : 'conversations');
  $('nav-my').onclick = () => { leaveChat('my'); void sessionsUI.load(); };
  $('account-devices-open').onclick = () => {
    mobileView('devices'); $('device-history-scroll').scrollTop = 0; $('device-history-title').focus(); void sessionsUI.load();
  };
  $('device-history-back').onclick = () => { mobileView('my'); $('account-devices-open').focus(); };
  $('privacy-button').onclick = () => $('privacy-dialog').showModal();
  $('privacy-close').onclick = () => $('privacy-dialog').close();
  $('chat-menu-button').onclick = () => $('chat-options').showModal();
  $('chat-options-close').onclick = () => $('chat-options').close();
  $('trust-notice').onclick = () => $('verify').click();
  $('verify').addEventListener('click', () => $('chat-options').close());
  $('clear-chat').addEventListener('click', () => $('chat-options').close());
  globalThis.whisperAndroidBack = () => {
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (dialog) {
      if (!dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) return;
      dialog.close(); return;
    }
    if (self && $('chat-screen').dataset.view === 'devices') $('device-history-back').click();
    else if (self && $('chat-screen').dataset.view === 'chat') leaveChat('conversations');
    else if (self && $('chat-screen').dataset.view === 'my') leaveChat(self.role === 'root' ? 'admin' : 'conversations');
    else globalThis.whisperAndroidExit();
  };
  globalThis.whisperAndroidPause = () => { androidPaused = true; generation++; stopRealtime(); closeImage(); if (!suspendedReading) suspendMessageView(); sessionsUI.clear(); };
  globalThis.whisperAndroidResume = () => {
    androidPaused = false; lifecycle.tick({ animate: false });
    if (savedLoginPending) void restoreSavedLogin();
    else { void sync().then(startRealtime); if (self && ['my', 'devices'].includes($('chat-screen').dataset.view)) void sessionsUI.load(); }
  };
  globalThis.whisperAndroidLock = lock;
  globalThis.whisperAndroidNetworkRestored = () => {
    if (androidPaused) return;
    if (savedLoginPending) void restoreSavedLogin(); else void sync().then(startRealtime);
  };
  globalThis.whisperAndroidNetworkLost = () => networkLost();
  globalThis.whisperAndroidSessionRevoked = () => { if (self) { lock(); toast('登录已撤销，请重新登录。'); } };
}
document.addEventListener('visibilitychange', () => {
  lifecycle.tick({ animate: false });
  if (document.hidden) { generation++; stopRealtime(); closeImage(); }
  else if (!androidPaused) void sync().then(startRealtime);
});
window.addEventListener('focus', () => { lifecycle.tick({ animate: false }); webAccountUI?.resume(); if (realtimeSupported && !document.hidden) void sync().then(startRealtime); });
function networkLost() { generation++; stopRealtime(); connection(false); closeImage(); if (!suspendedReading) suspendMessageView(); }
window.addEventListener('offline', networkLost);
window.addEventListener('online', () => { if (savedLoginPending) void restoreSavedLogin(); else { void sync().then(startRealtime); webAccountUI?.resume(); } });
window.addEventListener('pagehide', () => { if (android) globalThis.whisperAndroidPause(); else { webPaused = true; lock({ keepSaved: true }); } });
window.addEventListener('pageshow', event => { if (!android && event.persisted) { webPaused = false; void restoreSavedLogin(); } });
pollTimer = setInterval(() => sync(false), 500);
try {
  if (!window.isSecureContext || !crypto.subtle) throw new Error('请使用 http://127.0.0.1 本机地址或 HTTPS 临时网址。');
  await ready;
  // Health discovery and protected-login restore run together, so an extra
  // health round-trip never blocks the saved account's empty conversation shell.
  const healthReady = (async () => {
    const health = await api('/api/health').catch(() => ({ environment: android || location.protocol === 'https:' ? 'cloud' : 'local' }));
    cloudMode = health.environment === 'cloud';
    if (cloudMode) pollIntervalMs = Math.max(2000, Number(health.pollIntervalMs) || 2000);
    realtimeSupported = Array.isArray(health.capabilities) && health.capabilities.includes('realtime-sync-v1');
    if (realtimeSupported) { clearInterval(pollTimer); syncCursor = null; if (self) { await sync(); startRealtime(); } }
    if (self) { $('entry-kind').textContent = cloudMode ? '云端服务' : location.hostname.endsWith('.trycloudflare.com') ? '临时链接入口' : '本机入口'; webAccountUI?.resume(); }
  })();
  $('auth-submit').disabled = false; setMode('login');
  await restoreSavedLogin();
  await healthReady;
} catch (error) { hideRestoreNotice(); $('auth-screen').hidden = false; $('auth-error').textContent = '加密组件无法启动：' + error.message; $('auth-submit').textContent = '无法启动'; }
