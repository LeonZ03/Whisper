import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ready, b64, unb64, wipe, deriveCredentials, unlockIdentity, encryptMessage, decryptMessage, safetyCode } from '../src/crypto.mjs';
import { prepareEnrollment, preparePasswordChange } from '../src/account-client.mjs';

export const TTL = Object.freeze({ '1m': 60000, '1h': 3600000, '24h': 86400000, '7d': 604800000 });
export function normalizeServer(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 http://127.0.0.1:8787 或 HTTPS 服务地址。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('服务地址不能包含账号、密码、查询参数或路径。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('远程连接必须使用 HTTPS；仅回环地址允许 HTTP。');
  return url.origin;
}
export function usernameOf(value) {
  const username = String(value).trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error('用户名需为 3–24 位字母、数字或下划线。');
  return username;
}
// Public identity pins only; never credentials or message history.
export class PinStore {
  constructor(path) { this.path = path; this.memory = {}; }
  read() {
    if (!this.path) return this.memory;
    try {
      const text = readFileSync(this.path, 'utf8');
      if (text.length > 2000000) throw new Error('size');
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('format');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('CLI 公钥记录不可读取；为防止静默丢失信任记录，已阻止聊天。请检查 cli-pins.json。');
    }
  }
  key(origin, user, peer) { return JSON.stringify([origin, user.id, user.publicKey, peer.id]); }
  get(origin, user, peer) { return this.read()[this.key(origin, user, peer)]; }
  save(origin, user, peer, verified = false) {
    const data = this.read(), key = this.key(origin, user, peer), existing = data[key];
    if (existing && existing.publicKey !== peer.publicKey) throw new Error('对方公钥变化，禁止覆盖原信任记录。');
    data[key] = { ...existing, publicKey: peer.publicKey, verified: Boolean(verified || existing?.verified) };
    this.write(data);
  }
  repin(origin, user, peer) {
    const data = this.read(), key = this.key(origin, user, peer), existing = data[key];
    if (!existing || existing.publicKey === peer.publicKey) throw new Error('没有需要重新核对的公钥变化。');
    const history = Array.isArray(existing.history) ? existing.history : [];
    data[key] = { publicKey: peer.publicKey, verified: true, history: [...history, { publicKey: existing.publicKey, verified: Boolean(existing.verified), replacedAt: new Date().toISOString() }] };
    this.write(data);
  }
  write(data) {
    if (!this.path) { this.memory = data; return; }
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); }
    finally { try { unlinkSync(temporary); } catch {} }
  }
}
export class WhisperClient {
  constructor({ server, pinPath, loginStore, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    this.server = normalizeServer(server); this.pins = new PinStore(pinPath);
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.cookie = '';
    this.user = null; this.selected = null; this.conversations = []; this.messages = [];
    this.loginStore = loginStore; this.persistentLogin = false; this.loginNotice = ''; this.loginEpoch = 0;
    this.pollIntervalMs = 2000; this.ttl = '24h'; this.connected = false; this.supportsHistory = false; this.hasOlder = false; this.historyComplete = false;
  }
  async request(path, method = 'GET', body, timeoutMs = this.timeoutMs) {
    if (!path.startsWith('/api/')) throw new Error('无效的 API 路径。');
    const epoch = this.loginEpoch;
    let response;
    try {
      response = await this.fetchImpl(this.server + path, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'X-Whisper-Client': 'cli', 'X-Whisper-Device': `CLI / ${process.platform === 'win32' ? 'Windows' : process.platform}`.slice(0, 128), 'User-Agent': `WhisperCLI/Node (${process.platform})`.slice(0, 128), ...(this.cookie ? { Cookie: this.cookie } : {}), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', Origin: this.server, 'X-Whisper-Request': '1' }) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
    } catch { this.connected = false; throw new Error('连接中断或请求超时。检查服务地址；本机先运行 start.cmd。'); }
    const result = await response.json().catch(() => null);
    if (!result) throw new Error('服务器返回了无效 JSON；请确认是 Whisper 服务。');
    if (!response.ok) {
      const error = new Error(typeof result.error === 'string' ? result.error : `请求失败 (${response.status})`);
      error.status = response.status;
      if (response.status === 401 && epoch === this.loginEpoch) { this.lock(); await this.loginStore?.clear(this.server); }
      throw error;
    }
    const session = response.headers.get('set-cookie')?.match(/(?:^|,\s*)whisper_session=([A-Za-z0-9_-]{43})(?:;|$)/);
    if (session && epoch === this.loginEpoch) this.cookie = `whisper_session=${session[1]}`;
    this.connected = true; return result;
  }
  async health() {
    const result = await this.request('/api/health');
    if (result.app !== 'Whisper' || result.ok !== true) throw new Error('这个地址不是兼容的 Whisper 服务。');
    this.supportsHistory = result.capabilities?.includes('message-history-v1') === true;
    this.pollIntervalMs = result.environment === 'cloud' ? Math.max(2000, Number(result.pollIntervalMs) || 2000) : 2000;
    return result;
  }
  async authenticate({ username, password, register = false, applicationMessage = '' }) {
    if (this.user) throw new Error('请先 /logout，再切换账号。');
    username = usernameOf(username);
    if (!password || password.length > 1024) throw new Error('请输入密码（最长 1024 字符）。');
    if (username === 'root') throw new Error('root 管理员请使用网页入口登录；CLI 不提供管理员会话。');
    const epoch = ++this.loginEpoch;
    const current = () => { if (epoch !== this.loginEpoch) throw Error('登录已取消。'); };
    await ready; await this.health(); current(); let credentials, identity, secretKey;
    try {
      if (register) {
        const enrollment = await prepareEnrollment(password, applicationMessage);
        const result = await this.request('/api/auth/register', 'POST', { username, ...enrollment });
        if (this.cookie) { this.lock(); throw new Error('注册申请意外返回会话，已取消。'); }
        if (result.pending !== true) throw new Error('服务器未确认待审批申请。');
        return result;
      }
      this.persistentLogin = await this.loginStore?.available() === true; current();
      this.loginNotice = this.persistentLogin ? '' : '当前环境无法保护保存登录，关闭 CLI 后需要重新登录。';
      const salt = (await this.request('/api/auth/salt?username=' + encodeURIComponent(username))).salt; current();
      credentials = await deriveCredentials(password, salt); password = ''; current(); let user;
      user = await this.request('/api/auth/login', 'POST', { username, authKey: b64(credentials.authKey), persistent: this.persistentLogin }); current();
      if (user.role !== 'member' || user.username === 'root') throw new Error('管理员会话只能在网页使用。');
      secretKey = unlockIdentity(user, credentials.vaultKey);
      if (!this.cookie) throw new Error('服务器没有返回登录会话。');
      if (this.persistentLogin) {
        const saved = await this.loginStore.save(this.server, { id: user.id, username: user.username, publicKey: user.publicKey, secretKey: b64(secretKey), cookie: this.cookie });
        current(); if (!saved) throw Error('登录保存已取消。');
      }
      this.user = { id: user.id, username: user.username, publicKey: user.publicKey, secretKey };
    } catch (error) {
      wipe(identity?.secretKey); wipe(secretKey);
      if (epoch === this.loginEpoch) await this.logout().catch(() => {});
      throw error;
    } finally { password = ''; wipe(credentials?.authKey); wipe(credentials?.vaultKey); }
  }
  async changePassword(currentPassword, newPassword) {
    this.requireUser();
    const me = await this.request('/api/account/me');
    if (me.id !== this.user.id || me.publicKey !== this.user.publicKey) throw new Error('账号身份已改变，请重新登录。');
    const envelope = await preparePasswordChange(me, currentPassword, newPassword);
    try { return await this.request('/api/account/password', 'POST', envelope); }
    finally { this.lock(); await this.loginStore?.clear(this.server); }
  }
  async recover({ username, recoveryCode, password }) {
    if (this.user) throw new Error('请先 /logout。');
    username = usernameOf(username);
    if (username === 'root') throw new Error('root 请使用所有者恢复工具。');
    const enrollment = await prepareEnrollment(password);
    const result = await this.request('/api/auth/recover', 'POST', { username, recoveryCode, ...enrollment });
    await this.loginStore?.clear(this.server); return result;
  }
  requireUser() { if (!this.user) throw new Error('请先输入 /login 或 /register。'); }
  requireChat() { this.requireUser(); if (!this.selected) throw new Error('请先 /chat 对方用户名。'); }
  trust() {
    if (!this.selected || !this.user) return { blocked: false, verified: false };
    const peer = this.selected.peer; let pin = this.pins.get(this.server, this.user, peer);
    if (!pin) { this.pins.save(this.server, this.user, peer); pin = this.pins.get(this.server, this.user, peer); }
    return { blocked: pin.publicKey !== peer.publicKey, verified: pin.publicKey === peer.publicKey && pin.verified === true };
  }
  async sync() {
    this.requireUser(); const list = await this.request('/api/conversations');
    if (!Array.isArray(list)) throw new Error('会话列表格式无效。');
    this.conversations = list; if (!this.selected) return;
    const selected = list.find((item) => item.id === this.selected.id);
    if (!selected) { this.selected = null; this.messages = []; return; }
    this.selected = selected;
    if (this.trust().blocked) { this.messages = []; return; }
    const messages = await this.request(`/api/conversations/${selected.id}/messages`);
    if (!Array.isArray(messages)) throw new Error('消息列表格式无效。');
    const recent = messages.filter((m) => m.expiresAt > Date.now());
    const first = recent[0]?.seq;
    if (!this.messages.length && recent.length >= 200) this.historyComplete = false;
    let older = this.supportsHistory && recent.length >= 200 ? this.messages.filter((m) => m.seq < first && m.expiresAt > Date.now()) : [];
    if (older.length) {
      const state = await this.request(`/api/conversations/${selected.id}/message-state?fromSeq=${older[0].seq}&throughSeq=${first - 1}`);
      if (!Array.isArray(state)) throw new Error('历史状态格式无效。');
      const live = new Map(state.map((m) => [m.id, m]));
      const cached = new Set(older.map((m) => m.id));
      if (state.some((m) => !cached.has(m.id))) { older = []; this.historyComplete = false; }
      older = older.filter((m) => live.has(m.id)).map((m) => ({ ...m, consumedAt: live.get(m.id).consumedAt }));
    }
    this.messages = [...older, ...recent];
    if (recent.length < 200) this.historyComplete = true;
    this.hasOlder = this.supportsHistory && !this.historyComplete && this.messages.length > 0;
  }
  async loadOlder() {
    this.requireChat();
    if (!this.supportsHistory) throw new Error('服务器尚未支持历史分页，请服务提供者更新并重启服务。');
    if (!this.hasOlder || !this.messages.length) return 0;
    if (this.trust().blocked) throw new Error('公钥变化，已阻止历史解密。');
    const id = this.selected.id, user = this.user, before = this.messages[0].seq;
    const page = await this.request(`/api/conversations/${id}/history?beforeSeq=${before}`);
    if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean' || page.messages.some((m) => !Number.isSafeInteger(m.seq) || m.seq >= before || m.conversationId !== id)) throw new Error('历史分页响应无效。');
    if (this.selected?.id !== id || this.user !== user) return 0;
    const previous = page.messages.filter((m) => m.expiresAt > Date.now());
    this.messages = [...new Map([...previous, ...this.messages].map((m) => [m.id, m])).values()].sort((a, b) => a.seq - b.seq);
    this.historyComplete = !page.hasMore; this.hasOlder = page.hasMore;
    return previous.length;
  }
  async chat(username) {
    this.requireUser();
    const conversation = await this.request('/api/conversations', 'POST', { username: usernameOf(username) });
    this.selected = conversation; this.messages = []; this.historyComplete = false; this.hasOlder = false; await this.sync(); return conversation;
  }
  async send(text, { onPending } = {}) {
    this.requireChat(); if (!text.trim()) return;
    if (Buffer.byteLength(text, 'utf8') > 16000) throw new Error('文字过长；单条最多 16,000 个 UTF-8 字节。');
    // Recheck peer identity before encryption, not only on background polling.
    await this.sync(); this.requireChat();
    if (this.trust().blocked) throw new Error('对方公钥变化，已阻止发送与解密。请通过可信渠道核实。');
    const envelope = encryptMessage(this.user, this.selected.peer, this.selected.id, text, { ttlMs: TTL[this.ttl] });
    onPending?.({ id: envelope.id, expiresAt: envelope.expiresAt });
    try { await this.request(`/api/conversations/${this.selected.id}/messages`, 'POST', envelope); }
    catch (error) { if (!error.status) error.message = '发送结果未知：请先 /refresh 核对，勿立即重发以免重复。'; throw error; }
    return envelope.id;
  }
  viewMessages() {
    if (!this.user || !this.selected || this.trust().blocked) return [];
    return this.messages.filter((m) => m.expiresAt > Date.now()).map((m) => {
      let text;
      if (m.type === 'image') text = m.consumedAt ? '[阅后图片已清理]' : '[阅后图片 · 请在网页查看；CLI 不领取]';
      else { try { text = decryptMessage(m, this.user, this.selected.peer).body; } catch { text = '[无法解密：内容、期限或身份校验失败]'; } }
      return { id: m.id, seq: m.seq, own: m.senderId === this.user.id, createdAt: m.createdAt, expiresAt: m.expiresAt, type: m.type, consumedAt: m.consumedAt, text };
    });
  }
  async safety() { this.requireChat(); return safetyCode(this.user, this.selected.peer); }
  verify(expectedPeerKey) {
    this.requireChat();
    if (this.selected.peer.publicKey !== expectedPeerKey || this.trust().blocked) throw new Error('公钥变化，不能标记为已核对。');
    this.pins.save(this.server, this.user, this.selected.peer, true);
  }
  repin(expectedPeerKey, confirmedSafetyCode) {
    this.requireChat();
    if (!this.trust().blocked || this.selected.peer.publicKey !== expectedPeerKey) throw new Error('对方公钥已再次变化，请重新核对。');
    return safetyCode(this.user, this.selected.peer).then((code) => {
      if (confirmedSafetyCode.replaceAll(/\s/g, '') !== code.replaceAll(/\s/g, '')) throw new Error('安全码不匹配，信任记录未改变。');
      this.pins.repin(this.server, this.user, this.selected.peer);
    });
  }
  async remove(id) { this.requireChat(); await this.request('/api/messages/' + encodeURIComponent(id), 'DELETE'); }
  async clear(conversationId, throughSeq) {
    this.requireChat(); if (this.selected.id !== conversationId) throw new Error('会话已切换，取消清空。');
    await this.request(`/api/conversations/${conversationId}/clear`, 'POST', { throughSeq });
  }
  async restoreSavedLogin() {
    if (!this.loginStore || this.user) return false;
    const epoch = ++this.loginEpoch; let saved, key;
    // Even an offline first launch must not erase an existing vault on /quit.
    this.persistentLogin = true;
    try { saved = await this.loginStore.load(this.server); }
    catch { await this.loginStore.clear(this.server); this.loginNotice = '保存的登录无法解锁，请重新 /login。'; return false; }
    if (!saved || epoch !== this.loginEpoch) { if (!saved) this.persistentLogin = false; return false; }
    try {
      await ready;
      if (typeof saved.id !== 'string' || typeof saved.publicKey !== 'string' || typeof saved.secretKey !== 'string' || !/^whisper_session=[A-Za-z0-9_-]{43}$/.test(saved.cookie)) throw Object.assign(Error('保存的身份无效。'), { status: 401 });
      key = unb64(saved.secretKey); if (key.length !== 32) throw Object.assign(Error('保存的身份无效。'), { status: 401 });
      if (epoch !== this.loginEpoch) return false;
      this.cookie = saved.cookie;
      const me = await this.request('/api/account/me');
      if (epoch !== this.loginEpoch) return false;
      if (me.id !== saved.id || me.publicKey !== saved.publicKey || me.role !== 'member' || me.mustChangePassword) throw Object.assign(Error('账号身份已变化。'), { status: 401 });
      this.user = { id: me.id, username: me.username, publicKey: me.publicKey, secretKey: key }; key = null;
      this.persistentLogin = true; this.loginNotice = ''; return true;
    } catch (error) {
      if (epoch !== this.loginEpoch) return false;
      this.lock();
      if ([401, 403].includes(error.status)) { await this.loginStore.clear(this.server); this.loginNotice = '登录已失效，请重新 /login。'; return false; }
      throw error;
    } finally { wipe(key); saved = null; }
  }
  lock() { this.loginEpoch++; wipe(this.user?.secretKey); this.user = null; this.cookie = ''; this.selected = null; this.conversations = []; this.messages = []; this.hasOlder = false; this.historyComplete = false; }
  async suspend() { if (this.persistentLogin || (!this.cookie && this.loginStore)) this.lock(); else await this.logout(); }
  async logout() {
    const origin = this.server, cookie = this.cookie;
    this.lock(); this.persistentLogin = false;
    // Clear local recovery immediately, even when the service is unreachable.
    const cleared = this.loginStore?.clear(origin);
    try {
      if (cookie) await this.fetchImpl(origin + '/api/auth/logout', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1500),
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' }, body: '{}' });
    } finally { await cleared; }
  }
}
