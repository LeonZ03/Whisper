import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stretch = promisify(scrypt);
const DAY = 86_400_000;
const USERNAME = /^[a-z0-9_]{3,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (s) => createHash('sha256').update(s).digest('hex');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const equal = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
function base64(value, bytes, max = bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400, '无效的加密数据。');
  const out = Buffer.from(value, 'base64');
  if (out.length < bytes || out.length > max || out.toString('base64') !== value) fail(400, '无效的加密数据长度。');
  return value;
}

export async function createWhisperServer(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.WHISPER_DATA_DIR || resolve(root, 'data'));
  mkdirSync(dataDir, { recursive: true });
  const invitePath = resolve(dataDir, 'invite-code.txt');
  if (!existsSync(invitePath)) writeFileSync(invitePath, 'WH-' + randomBytes(12).toString('hex') + '\n', { mode: 0o600 });
  const inviteCode = readFileSync(invitePath, 'utf8').trim();
  const db = new DatabaseSync(resolve(dataDir, 'whisper.sqlite'));
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, public_key TEXT NOT NULL,
      salt TEXT NOT NULL, vault_nonce TEXT NOT NULL, vault_cipher TEXT NOT NULL,
      auth_salt TEXT NOT NULL, auth_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, a TEXT NOT NULL REFERENCES users(id), b TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, UNIQUE(a,b), CHECK(a < b)
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id), sender_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK(type IN ('text','image')), nonce TEXT,
      ciphertext TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id,seq);
    CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at);`);
  const instance = randomUUID();
  const sessions = new Map();
  const limits = new Map();
  const fakeSaltKey = randomBytes(32);
  const allowed = new Set();
  let authBusy = 0;
  let publicOrigin = null;
  let httpServer;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  function prune() {
    const now = Date.now();
    db.prepare('DELETE FROM messages WHERE expires_at <= ?').run(now);
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
  }
  prune();
  const janitor = setInterval(prune, 15_000); janitor.unref();
  function originFor(req) {
    const host = req.get('host');
    const local = `http://${host}`;
    const remote = `https://${host}`;
    return allowed.has(local) ? local : allowed.has(remote) ? remote : null;
  }
  function rate(req, scope, max, windowMs = 60_000) {
    const isTunnel = publicOrigin && originFor(req) === publicOrigin;
    const ip = isTunnel ? (req.get('cf-connecting-ip') || req.socket.remoteAddress) : req.socket.remoteAddress;
    const key = `${scope}:${ip}`;
    const now = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until <= now) {
      if (limits.size >= 10_000) fail(503, '请求过多，请稍后重试。');
      entry = { count: 0, until: now + windowMs }; limits.set(key, entry);
    }
    if (++entry.count > max) fail(429, '操作太频繁，请稍后重试。');
  }
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    });
    const origin = originFor(req);
    if (!origin) return res.status(403).json({ error: '不允许的访问地址。' });
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.get('origin') !== origin || req.get('x-whisper-request') !== '1') return res.status(403).json({ error: '请求来源校验失败。' });
      if (!req.is('application/json')) return res.status(415).json({ error: '需要 JSON 请求。' });
    }
    next();
  });
  app.use('/api', (req, _res, next) => { rate(req, 'api', 600); next(); });
  app.use('/api/auth', (req, _res, next) => { rate(req, 'auth', 30); next(); });
  app.use(express.json({ limit: '2300kb', strict: true }));
  function sessionToken(req) {
    const m = /(?:^|;\s*)whisper_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.get('cookie') || '');
    return m ? m[1] : null;
  }
  function auth(req, _res, next) {
    const token = sessionToken(req); const session = token && sessions.get(hash(token));
    if (!session || session.expires <= Date.now()) fail(401, '登录已过期，请重新登录。');
    req.userId = session.userId; next();
  }
  function issueSession(req, res, userId) {
    const old = sessionToken(req); if (old) sessions.delete(hash(old));
    const token = randomBytes(32).toString('base64url');
    const existing = [...sessions].filter(([, v]) => v.userId === userId);
    for (const [key] of existing.slice(0, Math.max(0, existing.length - 7))) sessions.delete(key);
    sessions.set(hash(token), { userId, expires: Date.now() + 12 * 3_600_000 });
    res.cookie('whisper_session', token, { httpOnly: true, secure: originFor(req).startsWith('https:'), sameSite: 'strict', path: '/', maxAge: 12 * 3_600_000 });
  }
  const publicUser = (u) => ({ id: u.id, username: u.username, publicKey: u.public_key });
  const vaultUser = (u) => ({ ...publicUser(u), salt: u.salt, vault: { nonce: u.vault_nonce, ciphertext: u.vault_cipher } });
  function conversation(req, id) {
    const row = db.prepare('SELECT * FROM conversations WHERE id=? AND (a=? OR b=?)').get(id, req.userId, req.userId);
    if (!row) fail(404, '会话不存在或无权访问。');
    return row;
  }
  function message(req, id) {
    const row = db.prepare('SELECT m.* FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE m.id=? AND (c.a=? OR c.b=?) AND m.expires_at>?').get(id, req.userId, req.userId, Date.now());
    if (!row) fail(404, '消息已删除、已过期或无权访问。');
    return row;
  }
  const envelope = (m, reveal = false) => ({ seq: m.seq, id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, type: m.type,
    nonce: m.type === 'text' || reveal ? m.nonce : null,
    ciphertext: m.type === 'text' || reveal ? m.ciphertext : null,
    createdAt: m.created_at, expiresAt: m.expires_at, consumedAt: m.consumed_at });
  async function authHash(secret, salt) {
    if (authBusy >= 2) fail(429, '正在处理登录，请稍后重试。');
    authBusy++;
    try { return (await stretch(secret, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 })).toString('base64'); }
    finally { authBusy--; }
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'Whisper', version: '0.2.0', instance, capabilities: ['message-history-v1'] }));
  app.get('/api/auth/salt', (req, res) => {
    const username = String(req.query.username || '').toLowerCase();
    if (!USERNAME.test(username)) fail(400, '用户名需为 3–24 位小写字母、数字或下划线。');
    const user = db.prepare('SELECT salt FROM users WHERE username=?').get(username);
    res.json({ salt: user?.salt || createHmac('sha256', fakeSaltKey).update(username).digest().subarray(0, 16).toString('base64'), iterations: 600000 });
  });
  app.post('/api/auth/register', async (req, res) => {
    const { username, invite, authKey, salt, publicKey, vault } = req.body;
    if (!equal(invite || '', inviteCode)) fail(403, '邀请码不正确，请向网站所有者索取。');
    if (typeof username !== 'string' || !USERNAME.test(username)) fail(400, '用户名需为 3–24 位小写字母、数字或下划线。');
    base64(authKey, 32); base64(salt, 16); base64(publicKey, 32);
    base64(vault?.nonce, 24); base64(vault?.ciphertext, 48);
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 50) fail(403, '此实验站最多允许 50 个账号。');
    if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) fail(409, '用户名已被使用。');
    const authSalt = randomBytes(16).toString('base64'); const verifier = await authHash(authKey, authSalt);
    const id = randomUUID();
    try { db.prepare('INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, username, publicKey, salt, vault.nonce, vault.ciphertext, authSalt, verifier, Date.now()); }
    catch (error) { if (String(error.message).includes('UNIQUE')) fail(409, '用户名已被使用。'); throw error; }
    issueSession(req, res, id);
    res.status(201).json(vaultUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
  });
  app.post('/api/auth/login', async (req, res) => {
    const { username, authKey } = req.body;
    if (typeof username !== 'string' || !USERNAME.test(username)) fail(401, '用户名或密码不正确。');
    base64(authKey, 32);
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const candidate = await authHash(authKey, user?.auth_salt || fakeSaltKey.toString('base64'));
    if (!user || !equal(candidate, user.auth_hash)) fail(401, '用户名或密码不正确。');
    issueSession(req, res, user.id); res.json(vaultUser(user));
  });
  app.post('/api/auth/logout', (req, res) => {
    const token = sessionToken(req); if (token) sessions.delete(hash(token));
    res.clearCookie('whisper_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: originFor(req).startsWith('https:') });
    res.json({ ok: true });
  });
  app.get('/api/conversations', auth, (req, res) => {
    const rows = db.prepare(`SELECT c.id, c.a, c.b, c.created_at,
      COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id=c.id AND m.expires_at>?), c.created_at) AS updated
      FROM conversations c WHERE c.a=? OR c.b=? ORDER BY updated DESC`).all(Date.now(), req.userId, req.userId);
    res.json(rows.map((c) => ({ id: c.id, peer: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(c.a === req.userId ? c.b : c.a)), updatedAt: c.updated })));
  });
  app.post('/api/conversations', auth, (req, res) => {
    rate(req, 'newchat', 20);
    if (Object.keys(req.body).some((k) => k !== 'username')) fail(400, '仅支持指定一个用户名的双人会话。');
    const username = req.body.username;
    if (typeof username !== 'string' || !USERNAME.test(username)) fail(400, '请输入对方完整用户名。');
    const peer = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!peer || peer.id === req.userId) fail(404, '未找到该用户，或不能与自己聊天。');
    const [a, b] = [req.userId, peer.id].sort();
    db.prepare('INSERT OR IGNORE INTO conversations VALUES (?,?,?,?)').run(randomUUID(), a, b, Date.now());
    const c = db.prepare('SELECT id FROM conversations WHERE a=? AND b=?').get(a, b);
    res.json({ id: c.id, peer: publicUser(peer), updatedAt: Date.now() });
  });
  app.get('/api/conversations/:id/messages', auth, (req, res) => {
    conversation(req, req.params.id);
    const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND expires_at>? ORDER BY seq DESC LIMIT 200').all(req.params.id, Date.now());
    res.json(rows.reverse().map((m) => envelope(m)));
  });
  // Optional, backwards-compatible ciphertext pagination for the terminal client.
  function sequence(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) fail(400, '无效的消息游标。');
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail(400, '无效的消息游标。');
    return number;
  }
  app.get('/api/conversations/:id/history', auth, (req, res) => {
    conversation(req, req.params.id);
    const before = sequence(req.query.beforeSeq);
    const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND seq<? AND expires_at>? ORDER BY seq DESC LIMIT 201').all(req.params.id, before, Date.now());
    res.json({ messages: rows.slice(0, 200).reverse().map((m) => envelope(m)), hasMore: rows.length > 200 });
  });
  app.get('/api/conversations/:id/message-state', auth, (req, res) => {
    conversation(req, req.params.id);
    const from = sequence(req.query.fromSeq), through = sequence(req.query.throughSeq);
    if (through < from) fail(400, '无效的消息范围。');
    // Only IDs/lifecycle metadata. Images must not be claimed by scrolling.
    const rows = db.prepare('SELECT id,seq,consumed_at,expires_at FROM messages WHERE conversation_id=? AND seq>=? AND seq<=? AND expires_at>? ORDER BY seq LIMIT 10000').all(req.params.id, from, through, Date.now());
    res.json(rows.map((m) => ({ id: m.id, seq: m.seq, consumedAt: m.consumed_at, expiresAt: m.expires_at })));
  });
  app.post('/api/conversations/:id/messages', auth, (req, res) => {
    const c = conversation(req, req.params.id); rate(req, `send:${req.userId}`, 90);
    const { id, type, nonce, ciphertext, expiresAt } = req.body;
    if (typeof id !== 'string' || !UUID.test(id) || !['text', 'image'].includes(type)) fail(400, '无效的消息。');
    const now = Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 7 * DAY + 60_000) fail(400, '消息保留时间必须在 7 天以内。');
    if (type === 'image' && expiresAt > now + DAY + 60_000) fail(400, '未查看图片最多保留 24 小时。');
    base64(nonce, 24); base64(ciphertext, 17, type === 'text' ? 24_000 : 1_500_000);
    if (db.prepare('SELECT COUNT(*) AS n FROM messages').get().n >= 10_000) fail(507, '消息数量达到实验站上限，请先清理。');
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const free = db.prepare('PRAGMA freelist_count').get().freelist_count;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    if ((pages - free) * pageSize + ciphertext.length > 512 * 1024 * 1024) fail(507, '存储达到实验站上限，请先清理。');
    try {
      db.prepare('INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, c.id, req.userId, type, nonce, ciphertext, now, expiresAt);
    } catch (error) { if (String(error.message).includes('UNIQUE')) fail(409, '消息已存在，不能重复发送。'); throw error; }
    res.status(201).json({ ok: true, id });
  });
  app.post('/api/messages/:id/open', auth, (req, res) => {
    const m = message(req, req.params.id);
    if (m.type !== 'image' || m.sender_id === req.userId) fail(403, '只有接收方可以打开阅后图片。');
    if (m.consumed_at || !m.ciphertext) fail(410, '图片已经被打开，无法再次查看。');
    // Synchronous SQLite operations make the consume-before-delivery transition atomic in this process.
    const changed = db.prepare('UPDATE messages SET ciphertext=NULL, nonce=NULL, consumed_at=? WHERE id=? AND consumed_at IS NULL').run(Date.now(), m.id);
    if (changed.changes !== 1) fail(410, '图片已经被打开。');
    res.json(envelope(m, true));
  });
  app.delete('/api/messages/:id', auth, (req, res) => {
    const m = message(req, req.params.id);
    db.prepare('DELETE FROM messages WHERE id=?').run(m.id); res.json({ ok: true });
  });
  app.post('/api/conversations/:id/clear', auth, (req, res) => {
    conversation(req, req.params.id);
    const cutoff = req.body.throughSeq;
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) fail(400, '无效的清理范围。');
    db.prepare('DELETE FROM messages WHERE conversation_id=? AND seq<=?').run(req.params.id, cutoff);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(express.static(resolve(root, 'public'), { etag: false, lastModified: false, dotfiles: 'deny', index: 'index.html', cacheControl: false }));
  app.use((_req, res) => res.status(404).send('Not found'));
  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    // Do not log bodies, cookies, keys, usernames or plaintext.
    if (status >= 500) console.error('[Whisper] Internal error:', error.code || error.name);
    res.status(status).json({ error: status >= 500 ? '服务暂时不可用，请重试。' : error.type === 'entity.too.large' ? '发送内容过大。' : error.message });
  });
  const port = options.port ?? Number(process.env.WHISPER_PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid WHISPER_PORT');
  await new Promise((resolveListen, reject) => {
    httpServer = app.listen(port, '127.0.0.1', resolveListen); httpServer.once('error', reject);
  }).catch((error) => { clearInterval(janitor); db.close(); throw error; });
  httpServer.requestTimeout = 30_000; httpServer.headersTimeout = 15_000;
  const localUrl = `http://127.0.0.1:${httpServer.address().port}`;
  allowed.add(localUrl); allowed.add(`http://localhost:${httpServer.address().port}`);
  return {
    localUrl, instance, inviteCode, dataDir, db,
    setPublicOrigin(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(parsed.hostname) || parsed.port) throw new Error('Invalid tunnel origin');
      if (publicOrigin) allowed.delete(publicOrigin);
      publicOrigin = parsed.origin; allowed.add(publicOrigin);
    },
    async close() {
      clearInterval(janitor); sessions.clear(); fakeSaltKey.fill(0);
      httpServer.closeAllConnections();
      await new Promise((r) => httpServer.close(r)); db.close();
    }
  };
}
