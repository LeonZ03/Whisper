import { ready, b64, unb64, wipe, deriveCredentials, unlockIdentity, encryptMessage, decryptMessage, safetyCode } from './crypto.mjs';
import { MessageLifecycle } from './message-lifecycle.mjs';
import { accountUI } from './account-ui.mjs';
import { prepareEnrollment, validateNewPassword } from './account-client.mjs';
const $ = (id) => document.getElementById(id);
let self = null, selected = null, conversations = [], messages = [], mode = 'login';
let syncing = false, generation = 0, toastTimer, signature = '', imageTimer, imageUrl, viewingId, safetyPeer;
let blocked = false, sending = false;
let cloudMode = false, pollIntervalMs = 1500, nextPollAt = 0;
const messageCards = new Map();
const lifecycle = new MessageLifecycle($('messages'), (id) => {
  messageCards.delete(id); messages = messages.filter((m) => m.id !== id);
  if (viewingId === id) closeImage();
});
function clearMessageView() { lifecycle.clear(); messageCards.clear(); messages = []; signature = ''; }
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
async function api(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000),
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Whisper-Request': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  } catch { throw new Error('连接中断。请确认本机服务与临时隧道仍在运行。'); }
  const result = await response.json().catch(() => ({ error: '服务器返回了无效响应。' }));
  if (!response.ok) { const error = new Error(result.error || '请求失败。'); error.status = response.status; throw error; }
  return result;
}
function setMode(next) {
  mode = next; $('register-fields').hidden = mode !== 'register';
  $('activation-field').hidden = mode !== 'login' || $('username').value.trim().toLowerCase() !== 'root';
  $('password').minLength = 1;
  $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  $('password').placeholder = mode === 'register' ? '新密码：1–12 个字符' : '请输入完整密码（旧长密码仍可登录）';
  $('auth-title').textContent = mode === 'register' ? '申请一个账号' : '回到你的会话';
  $('auth-subtitle').textContent = mode === 'register' ? '管理员批准后才能登录。身份密钥将在你的浏览器生成。' : '使用用户名和密码登录，并在本机解锁密钥。';
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
    toast('新身份已设置。请重新登录，并与联系人通过可信渠道核对新安全码。');
    form.hidden = true; setMode('login'); $('username').value = username;
  } catch (error) { $('recovery-error').textContent = error.message; }
  finally { password = ''; for (const id of ['recovery-code','recovery-password','recovery-repeat']) $(id).value = ''; submit.disabled = false; }
};
$('auth-form').onsubmit = async (event) => {
  event.preventDefault(); if ($('auth-submit').disabled) return;
  const username = $('username').value.trim().toLowerCase(); let password = $('password').value;
  const currentMode = mode; const activationCode = $('activation-code').value; let credentials, secretKey;
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
    credentials = await deriveCredentials(password, salt); password = ''; $('password').value = '';
    let user;
    user = await api('/api/auth/login', 'POST', { username, authKey: b64(credentials.authKey), activationCode });
    secretKey = unlockIdentity(user, credentials.vaultKey);
    self = { id: user.id, username: user.username, publicKey: user.publicKey, secretKey, role: user.role, mustChangePassword: user.mustChangePassword, activationCode: user.mustChangePassword ? activationCode : '' };
    generation++; $('auth-screen').hidden = true; $('chat-screen').hidden = false;
    $('self-name').textContent = '@' + self.username;
    $('entry-kind').textContent = cloudMode ? '云端服务' : location.hostname.endsWith('.trycloudflare.com') ? '临时链接入口' : '本机入口';
    $('activation-code').value = ''; selected = null; conversations = []; messages = []; signature = ''; renderConversations();
    $('empty-state').hidden = false; $('conversation-panel').hidden = true;
    await accountControls.enter(self);
    if (self.role === 'member') await sync();
  } catch (error) {
    if (!self) wipe(secretKey); $('auth-error').textContent = error.message;
  } finally {
    password = ''; wipe(credentials?.authKey); wipe(credentials?.vaultKey);
    $('auth-submit').disabled = false; $('login-tab').disabled = false; $('register-tab').disabled = false;
    $('auth-submit').textContent = mode === 'register' ? '提交申请' : '解锁并进入';
  }
};
function lock() {
  generation++; wipe(self?.secretKey); self = null; selected = null; conversations = []; messages = []; signature = '';
  accountControls.clear();
  closeImage(); $('safety-dialog').close(); $('message-input').value = ''; $('password').value = ''; $('activation-code').value = '';
  clearMessageView(); $('conversations').replaceChildren(); $('safety-code').textContent = '';
  $('chat-screen').hidden = true; $('auth-screen').hidden = false;
}
const accountControls = accountUI({ api, getSelf: () => self, lock, toast });
$('logout').onclick = async () => { try { await api('/api/auth/logout', 'POST'); } catch {} finally { lock(); } };
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
  $('verify').textContent = blocked ? '核对新身份' : verified ? '已核对安全码' : '核对安全码';
  $('send').disabled = blocked || sending; $('image-button').disabled = blocked || sending;
}
async function selectConversation(c) {
  generation++; closeImage(); selected = c; messages = []; signature = ''; $('message-input').value = '';
  $('empty-state').hidden = true; $('conversation-panel').hidden = false;
  $('peer-title').textContent = c.peer.username; $('peer-avatar').textContent = c.peer.username[0];
  clearMessageView(); checkTrust(); renderConversations();
  await refreshMessages(); $('message-input').focus();
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
async function refreshMessages() {
  if (!self || !selected) return;
  const current = selected.id, epoch = generation;
  const result = await api(`/api/conversations/${current}/messages`);
  if (!self || generation !== epoch || selected?.id !== current) return;
  messages = result;
  if (viewingId && !messages.some((m) => m.id === viewingId)) closeImage();
  const sig = JSON.stringify(result.map((m) => [m.id, m.consumedAt, m.ciphertext, m.nonce, m.expiresAt]));
  if (sig !== signature) { signature = sig; renderMessages(); }
  connection(true);
}
async function sync(force = true) {
  if (!force && ((cloudMode && document.hidden) || Date.now() < nextPollAt)) return;
  nextPollAt = Date.now() + pollIntervalMs;
  if (!self || self.role !== 'member' || syncing) return; syncing = true; const epoch = generation;
  try {
    const result = await api('/api/conversations'); if (!self || generation !== epoch) return;
    const listChanged = JSON.stringify(result) !== JSON.stringify(conversations); conversations = result;
    if (selected) {
      const updated = conversations.find((c) => c.id === selected.id);
      if (updated) { const keyChanged = updated.peer.publicKey !== selected.peer.publicKey; selected = updated; checkTrust(); if (keyChanged) signature = ''; }
    }
    if (listChanged) renderConversations(); await refreshMessages(); connection(true);
  } catch (error) {
    if (!self || epoch !== generation) return;
    connection(false); clearMessageView(); signature = ''; closeImage();
    if (error.status === 401) { lock(); toast('登录已过期，请重新登录。'); }
  } finally { syncing = false; }
}
function renderMessages() {
  const box = $('messages'); const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  const oldScroll = box.scrollTop;
  messages = messages.filter((m) => m.expiresAt > Date.now());
  lifecycle.reconcile(new Set(messages.map((m) => m.id)), messages.length >= 200 ? messages[0].seq : 0);
  if (messages.length) box.querySelector('.messages-empty')?.remove();
  if (!messages.length) lifecycle.emptyState();
  for (const m of messages) {
    const key = JSON.stringify([m.ciphertext, m.nonce, m.expiresAt, m.consumedAt, blocked]);
    const previous = messageCards.get(m.id);
    if (previous?.key === key) continue;
    const own = m.senderId === self.id; const article = document.createElement('article'); article.className = 'message' + (own ? ' own' : ''); article.dataset.messageId = m.id; article.dataset.seq = String(m.seq);
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    if (blocked) { bubble.textContent = '公钥变化，已阻止解密。'; }
    else if (m.type === 'text') {
      try { const payload = decryptMessage(m, self, selected.peer); bubble.textContent = payload.body; }
      catch { bubble.textContent = '无法解密：消息可能损坏、过期或身份不匹配。'; }
    } else {
      bubble.classList.add('image-card'); const title = document.createElement('strong'); title.textContent = m.consumedAt ? '▧ 图片已清理' : '▧ 阅后图片';
      const desc = document.createElement('small'); desc.textContent = m.consumedAt ? '已经打开，不能再次查看' : '仅可打开一次 · 显示 10 秒'; bubble.append(title, desc);
      if (!m.consumedAt && !own) { const open = document.createElement('button'); open.className = 'quiet'; open.textContent = '打开图片'; open.dataset.openImage = m.id; open.onclick = () => openImage(m, open); bubble.append(open); }
      else if (!m.consumedAt) { const waiting = document.createElement('small'); waiting.textContent = '等待对方查看'; bubble.append(waiting); }
    }
    const meta = document.createElement('div'); meta.className = 'message-meta'; const time = document.createElement('span'); time.textContent = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    time.title = '到期时间：' + new Date(m.expiresAt).toLocaleString(); const remove = document.createElement('button'); remove.textContent = '双方删除';
    remove.onclick = async () => {
      if (!confirm('删除双方在本网站中的这条消息？无法删除截图、另存或其他副本。')) return;
      try { await api('/api/messages/' + m.id, 'DELETE'); await refreshMessages(); } catch (error) { toast(error.message); }
    };
    const countdown = document.createElement('span'); countdown.className = 'message-countdown';
    countdown.setAttribute('role', 'timer'); countdown.setAttribute('aria-live', 'off');
    countdown.title = '到期即清理；动画不延长保留时间';
    if (m.consumedAt) { countdown.textContent = '已查看并清理'; countdown.classList.add('consumed'); }
    meta.append(time, countdown, remove); article.append(bubble, meta);
    if (previous) { previous.element.replaceChildren(); previous.element.replaceWith(article); }
    else box.append(article);
    messageCards.set(m.id, { key, element: article });
    lifecycle.track(m.id, article, m.expiresAt, countdown, Boolean(m.consumedAt));
  }
  box.scrollTop = stick ? box.scrollHeight : oldScroll;
}
$('message-form').onsubmit = async (event) => {
  event.preventDefault(); if (!self || !selected || blocked || sending) return;
  const text = $('message-input').value.trim(); if (!text) return;
  sending = true; checkTrust(); const c = selected;
  try {
    const message = encryptMessage(self, c.peer, c.id, text, { ttlMs: Number($('ttl').value) });
    await api(`/api/conversations/${c.id}/messages`, 'POST', message);
    if (selected?.id === c.id) { $('message-input').value = ''; await refreshMessages(); $('messages').scrollTop = $('messages').scrollHeight; }
  } catch (error) { toast(error.message); } finally { sending = false; checkTrust(); }
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
  if (file.size > 8 * 1024 * 1024) throw new Error('请选择小于 8 MB 的图片。');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片分辨率过大。');
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82)); canvas.width = canvas.height = 0;
    if (!blob || blob.size > 1_000_000) throw new Error('处理后的图片超过 1 MB，请选择更小的图片。');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
  } finally { bitmap.close(); }
}
$('image-button').onclick = () => { if (!blocked && !sending) $('image-input').click(); };
$('image-input').onchange = async () => {
  const file = $('image-input').files[0]; $('image-input').value = '';
  if (!file || !self || !selected || blocked || sending) return;
  if (!confirm('发送一次查看图片？对方打开后显示 10 秒，未打开最多保留 24 小时；无法阻止截图。GIF 将转换为静态图片。')) return;
  const c = selected, user = self; sending = true; checkTrust(); let prepared;
  try {
    prepared = await prepareImage(file); if (self !== user) return;
    const message = encryptMessage(user, c.peer, c.id, b64(prepared.bytes), { type: 'image', ttlMs: Math.min(Number($('ttl').value), 86400000), mime: prepared.mime });
    await api(`/api/conversations/${c.id}/messages`, 'POST', message); if (selected?.id === c.id) await refreshMessages(); toast('图片已在本机加密并发送。');
  } catch (error) { toast(error.message); } finally { wipe(prepared?.bytes); sending = false; checkTrust(); }
};
async function openImage(m, button) {
  if (!self || !selected || blocked || viewingId) return;
  if (!confirm('现在打开？关闭、切换标签页或 10 秒后将无法再次查看。网络中断也可能导致图片失效。')) return;
  const user = self, peer = selected.peer, c = selected.id; button.disabled = true;
  try {
    const envelope = await api('/api/messages/' + m.id + '/open', 'POST');
    if (self !== user || selected?.id !== c) return;
    const payload = decryptMessage(envelope, user, peer);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(payload.mime)) throw new Error('图片格式无效。');
    const bytes = unb64(payload.body); imageUrl = URL.createObjectURL(new Blob([bytes], { type: payload.mime })); wipe(bytes);
    viewingId = m.id; $('view-image').src = imageUrl;
    await $('view-image').decode();
    if (self !== user || selected?.id !== c || viewingId !== m.id || m.expiresAt <= Date.now()) { closeImage(); return; }
    $('image-dialog').showModal();
    const deadline = Math.min(Date.now() + 10_000, m.expiresAt);
    const tick = () => { const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); $('image-countdown').textContent = `${seconds} 秒后关闭`; if (!seconds) closeImage(); };
    tick(); imageTimer = setInterval(tick, 200); await refreshMessages();
  } catch (error) { closeImage(); toast(error.message); await refreshMessages().catch(() => {}); }
  finally { button.disabled = false; }
}
function closeImage() { clearInterval(imageTimer); imageTimer = null; $('image-dialog').close(); $('view-image').removeAttribute('src'); if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; viewingId = null; }
$('close-image').onclick = closeImage; $('image-dialog').addEventListener('cancel', closeImage);
document.addEventListener('visibilitychange', () => {
  lifecycle.tick({ animate: false });
  if (document.hidden) closeImage(); else sync();
});
window.addEventListener('focus', () => lifecycle.tick({ animate: false }));
window.addEventListener('offline', () => { connection(false); closeImage(); clearMessageView(); signature = ''; });
window.addEventListener('online', sync);
window.addEventListener('pagehide', lock);
setInterval(() => sync(false), 500);
try {
  if (!window.isSecureContext || !crypto.subtle) throw new Error('请使用 http://127.0.0.1 本机地址或 HTTPS 临时网址。');
  await ready; const health = await api('/api/health'); cloudMode = health.environment === 'cloud';
  if (cloudMode) pollIntervalMs = Math.max(5000, Number(health.pollIntervalMs) || 5000);
  $('auth-submit').disabled = false; setMode('login');
} catch (error) { $('auth-error').textContent = '加密组件无法启动：' + error.message; $('auth-submit').textContent = '无法启动'; }
