import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createWhisperServer } from '../server/app.mjs';
import { localStore } from '../accounts/local-store.mjs';
import { cloudFixture } from './cloud-fixture.mjs';
import { APP_SESSION_EXPIRES_AT, APP_COOKIE_MAX_AGE, sessionDevice } from '../accounts/session-devices.mjs';

const random = n => randomBytes(n).toString('base64');
const envelope = username => ({ username, passwordLength: 8, authKey: random(32), publicKey: random(32), salt: random(16), vault: { nonce: random(24), ciphertext: random(48) } });
const hash = value => createHash('sha256').update(value).digest('hex');
const cookieHash = cookie => hash(cookie.split('=')[1]);

test('device labels are bounded descriptive metadata', () => {
  const label = sessionDevice(new Request('https://example.invalid', { headers: { 'X-Whisper-Client': 'app', 'X-Whisper-Device': 'x'.repeat(300) } }));
  assert.equal(label.device.length, 128);
  assert.equal(sessionDevice(new Request('https://example.invalid', { headers: { 'X-Whisper-Client': 'anything' } })).method, 'web');
  assert.deepEqual(sessionDevice(new Request('https://example.invalid', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120' } })), { method: 'web', device: 'Edge / Windows' });
});

async function exercise(f, cloud) {
  const db = f.db;
  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const first = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const clientIPs = new Map();
  const request = async (path, method = 'GET', body, cookie, extra = {}) => {
    const sourceIP = extra['CF-Connecting-IP'] || clientIPs.get(cookie) || '127.0.0.1';
    if (cookie) clientIPs.set(cookie, sourceIP);
    const response = await fetch(f.url + path, { method, headers: {
      ...(method === 'GET' ? {} : { Origin: f.url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' }),
      ...(cookie ? { Cookie: cookie } : {}), ...(cloud ? { 'CF-Connecting-IP': sourceIP } : {}), ...extra
    }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    if (response.headers.get('set-cookie')) clientIPs.set(response.headers.get('set-cookie').split(';')[0], sourceIP);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie') };
  };
  const alice = envelope('devices_alice'), bob = envelope('devices_bob');
  for (const member of [alice, bob]) {
    assert.equal((await request('/api/auth/register', 'POST', member)).status, 202);
    await run("UPDATE users SET status='active' WHERE username=?", member.username);
  }
  const login = (member, headers = {}) => request('/api/auth/login', 'POST', { username: member.username, authKey: member.authKey }, undefined, headers);
  const web = await login(alice, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120', 'X-Forwarded-For': '198.51.100.123' });
  const app = await login(alice, { 'X-Whisper-Client': 'app', 'X-Whisper-Device': 'OPPO PKB110 / Android 15', 'CF-Connecting-IP': '203.0.113.8', 'X-Forwarded-For': '198.51.100.123' });
  const cli = await login(alice, { 'X-Whisper-Client': 'cli', 'X-Whisper-Device': 'CLI / Windows' });
  const other = await login(bob);
  for (const result of [web, app, cli, other]) assert.equal(result.status, 200);
  assert.match(web.setCookie, /Max-Age=43200/);
  assert.match(app.setCookie, /Max-Age=2147483647/);
  const appRow = await first('SELECT * FROM sessions WHERE token_hash=?', cookieHash(app.cookie));
  assert.equal(appRow.expires_at, APP_SESSION_EXPIRES_AT);
  const webRow = await first('SELECT * FROM sessions WHERE token_hash=?', cookieHash(web.cookie));
  assert.equal(webRow.expires_at - webRow.created_at, 43200000);
  const list = await request('/api/account/sessions', 'GET', undefined, app.cookie);
  assert.equal(list.status, 200); assert.equal(list.data.sessions.length, 3);
  assert.equal(list.data.history.length, 3); assert.ok(list.data.history.every(row => row.status === 'active'));
  for (const cookie of [web.cookie, app.cookie, cli.cookie]) {
    assert.ok(!JSON.stringify(list.data.history).includes(cookie.split('=')[1]));
    assert.ok(!JSON.stringify(list.data.history).includes(cookieHash(cookie)));
  }
  assert.deepEqual(new Set(list.data.sessions.map(row => row.method)), new Set(['web', 'app', 'cli']));
  const current = list.data.sessions.find(row => row.current);
  assert.equal(current.method, 'app'); assert.equal(current.device, 'OPPO PKB110 / Android 15');
  assert.equal(current.ip, cloud ? '203.0.113.8' : '127.0.0.1');
  assert.equal(list.data.sessions.find(row => row.method === 'web').device, 'Edge / Windows');
  assert.equal((await request('/api/account/sessions', 'GET', undefined, other.cookie)).data.sessions.length, 1);
  assert.equal((await request('/api/account/sessions', 'GET', undefined, other.cookie)).data.history.length, 1);
  assert.equal((await request('/api/account/sessions')).status, 401);
  for (const row of list.data.sessions) {
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'current', 'device', 'expiresAt', 'id', 'ip', 'method']);
    for (const cookie of [web.cookie, app.cookie, cli.cookie]) { assert.notEqual(row.id, cookie.split('=')[1]); assert.notEqual(row.id, cookieHash(cookie)); }
  }
  // A resumed app checks the existing session rather than issuing a second one.
  for (let i = 0; i < 3; i++) assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie)).status, 200);
  assert.equal((await first('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', appRow.user_id)).n, 3);
  assert.equal((await first('SELECT COUNT(*) AS n FROM login_history WHERE user_id=?', appRow.user_id)).n, 3);
  await run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() - 1, cookieHash(web.cookie));
  assert.equal((await request('/api/account/me', 'GET', undefined, web.cookie)).status, 401);
  assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie)).status, 200);
  assert.equal((await request('/api/account/sessions', 'GET', undefined, app.cookie)).data.sessions.length, 2);
  // A viewer cannot invent metadata for another device's old login.
  const legacyToken = randomBytes(32).toString('base64url'), legacyCookie = `whisper_session=${legacyToken}`;
  await run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,?)', hash(legacyToken), appRow.user_id, Date.now(), Date.now() + 43200000, appRow.credential_version);
  const legacyBefore = (await request('/api/account/sessions', 'GET', undefined, app.cookie)).data.sessions.find(row => row.method === 'unknown');
  assert.equal(legacyBefore.ip, 'unknown'); assert.equal(legacyBefore.device, '未知设备'); assert.notEqual(legacyBefore.id, hash(legacyToken));
  const legacyRow = await first('SELECT * FROM sessions WHERE token_hash=?', hash(legacyToken));
  // The old device itself reconnects; populate only that session without extending it.
  assert.equal((await request('/api/account/me', 'GET', undefined, legacyCookie, { 'CF-Connecting-IP': '203.0.113.20' })).status, 200);
  const legacy = (await request('/api/account/sessions', 'GET', undefined, app.cookie)).data.sessions.find(row => row.createdAt === legacyRow.created_at && row.expiresAt === legacyRow.expires_at);
  assert.equal(legacy.method, 'web'); assert.equal(legacy.ip, cloud ? '203.0.113.20' : '127.0.0.1');
  assert.equal((await first('SELECT expires_at FROM sessions WHERE token_hash=?', hash(legacyToken))).expires_at, legacyRow.expires_at);
  assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie, { 'CF-Connecting-IP': '203.0.113.9' })).status, 200);
  const updated = (await request('/api/account/sessions', 'GET', undefined, app.cookie)).data.sessions.find(row => row.current);
  assert.equal(updated.id, current.id); assert.equal(updated.method, 'app'); assert.equal(updated.device, current.device);
  assert.equal(updated.ip, cloud ? '203.0.113.9' : '127.0.0.1');
  assert.equal((await first('SELECT ip FROM session_devices WHERE token_hash=?', hash(legacyToken))).ip, legacy.ip);
  assert.equal((await request('/api/auth/logout', 'POST', {}, cli.cookie)).status, 200);
  assert.equal(await first('SELECT * FROM session_devices WHERE token_hash=?', cookieHash(cli.cookie)), null);
  const loggedOut = (await request('/api/account/sessions', 'GET', undefined, app.cookie)).data.history.find(row => row.method === 'cli');
  assert.equal(loggedOut.status, 'logout'); assert.ok(loggedOut.endedAt >= loggedOut.createdAt); assert.equal(loggedOut.current, false);
  await run('UPDATE users SET credential_version=credential_version+1 WHERE id=?', appRow.user_id);
  assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie)).status, 401);
  assert.equal((await first('SELECT end_reason FROM login_history WHERE id=?', current.id)).end_reason, 'revoked');
  assert.equal((await first('SELECT COUNT(*) AS n FROM session_devices')).n, 1); // Bob only.
  const renewed = await login(alice, { 'X-Whisper-Client': 'app' });
  assert.equal(renewed.status, 200);
  await run("UPDATE users SET status='deleted' WHERE id=?", appRow.user_id);
  assert.equal((await request('/api/account/me', 'GET', undefined, renewed.cookie)).status, 401);
  assert.equal(await first('SELECT * FROM session_devices WHERE token_hash=?', cookieHash(renewed.cookie)), null);
  // The eight-session cap removes metadata with the parent row.
  for (let i = 0; i < 10; i++) {
    const digest = hash(randomBytes(32));
    await db.batch([
      db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,?)').bind(digest, other.data.id, Date.now() + i, APP_SESSION_EXPIRES_AT, other.data.credentialVersion),
      db.prepare("INSERT INTO session_devices(token_hash,public_id,method,device,ip) SELECT token_hash,?,'app','Synthetic device','test' FROM sessions WHERE token_hash=?").bind(randomUUID(), digest)
    ]);
  }
  assert.equal((await first('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', other.data.id)).n, 8);
  assert.equal((await first('SELECT COUNT(*) AS n FROM session_devices')).n, 8);
  const restartLogin = await login(bob, { 'X-Whisper-Client': 'app', 'X-Whisper-Device': 'Restart probe' });
  assert.equal(restartLogin.status, 200);
  return restartLogin;
}

// A separate fixture keeps the real 30/minute auth limit intact while testing
// more than ten complete login/logout cycles through the actual API.
async function historyExercise(f) {
  const member = envelope('history_member');
  const request = async (path, body, cookie, device) => {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await fetch(f.url + path, { method, headers: {
      Origin: f.url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(device ? { 'X-Whisper-Client': device === 'Restart probe' ? 'app' : 'cli', 'X-Whisper-Device': device } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  assert.equal((await request('/api/auth/register', member)).status, 202);
  await f.db.prepare("UPDATE users SET status='active' WHERE username=?").bind(member.username).run();
  const login = device => request('/api/auth/login', { username: member.username, authKey: member.authKey }, undefined, device);
  const restartLogin = await login('Restart probe');
  assert.equal(restartLogin.status, 200);
  for (let i = 0; i < 12; i++) {
    const historical = await login(`History CLI ${i}`);
    assert.equal(historical.status, 200);
    assert.equal((await request('/api/auth/logout', {}, historical.cookie)).status, 200);
  }
  const retained = await request('/api/account/sessions', undefined, restartLogin.cookie);
  assert.equal(retained.status, 200); assert.equal(retained.data.history.length, 10);
  assert.ok(retained.data.history.every(row => row.status === 'logout'));
  assert.equal(retained.data.history[0].device, 'History CLI 11'); assert.equal(retained.data.history.at(-1).device, 'History CLI 2');
  assert.ok(retained.data.sessions.some(row => row.current && row.device === 'Restart probe'));
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM login_history WHERE user_id=?').bind(restartLogin.data.id).first()).n, 10);
}

test('local session devices, durable app expiry and account isolation', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-session-test-'));
  let app = await createWhisperServer({ port: 0, dataDir: dir });
  try {
    const restartLogin = await exercise({ url: app.localUrl, db: localStore(app.db) }, false);
    const before = app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    await app.close(); app = await createWhisperServer({ port: 0, dataDir: dir });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM session_devices').get().n, before);
    const resumed = await fetch(app.localUrl + '/api/account/me', { headers: { Cookie: restartLogin.cookie } });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).id, restartLogin.data.id);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Workers D1 session devices preserve legacy compatibility and revocation', { timeout: 120000 }, async () => {
  const f = await cloudFixture();
  try { await exercise(f, true); await historyExercise(f); } finally { await f.close(); }
});

test('local login history retains only the latest ten successful logins after logout', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-history-test-'));
  const app = await createWhisperServer({ port: 0, dataDir: dir });
  try { await historyExercise({ url: app.localUrl, db: localStore(app.db) }); }
  finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function persistenceExercise(f) {
  const request = async (path, method = 'GET', body, cookie) => {
    const response = await fetch(f.url + path, { method, headers: {
      ...(method === 'GET' ? {} : { Origin: f.url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' }),
      ...(cookie ? { Cookie: cookie } : {})
    }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], setCookie: response.headers.get('set-cookie') };
  };
  const member = async username => {
    const account = envelope(username);
    assert.equal((await request('/api/auth/register', 'POST', account)).status, 202);
    await f.db.prepare("UPDATE users SET status='active' WHERE username=?").bind(username).run();
    return account;
  };
  const login = (account, persistent) => request('/api/auth/login', 'POST', {
    username: account.username, authKey: account.authKey,
    ...(persistent === undefined ? {} : { persistent })
  });
  const expiry = cookie => f.db.prepare('SELECT s.created_at,s.expires_at,s.user_id FROM sessions s WHERE s.token_hash=?')
    .bind(cookieHash(cookie)).first();

  const durable = await member('persist_true');
  const saved = await login(durable, true);
  assert.equal(saved.status, 200);
  assert.match(saved.setCookie, new RegExp(`Max-Age=${APP_COOKIE_MAX_AGE}`));
  assert.equal((await expiry(saved.cookie)).expires_at, APP_SESSION_EXPIRES_AT);
  const beforeResume = await f.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').bind(saved.data.id).first();
  for (let i = 0; i < 3; i++) assert.equal((await request('/api/account/me', 'GET', undefined, saved.cookie)).status, 200);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').bind(saved.data.id).first()).n, beforeResume.n);
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM login_history WHERE user_id=?').bind(saved.data.id).first()).n, 1);
  assert.equal((await request('/api/auth/logout', 'POST', {}, saved.cookie)).status, 200);
  assert.equal(await expiry(saved.cookie), null);
  const logoutRow = await f.db.prepare('SELECT end_reason FROM login_history WHERE user_id=?').bind(saved.data.id).first();
  assert.equal(logoutRow.end_reason, 'logout');

  for (const [username, marker] of [['persist_missing', undefined], ['persist_string', 'true'], ['persist_false', false]]) {
    const account = await member(username), result = await login(account, marker);
    assert.equal(result.status, 200);
    assert.match(result.setCookie, /Max-Age=43200/);
    const row = await expiry(result.cookie);
    assert.equal(row.expires_at - row.created_at, 43200000);
  }

  const forced = await member('persist_forced');
  await f.db.prepare('UPDATE users SET must_change=1 WHERE username=?').bind(forced.username).run();
  const forcedLogin = await login(forced, true);
  assert.equal(forcedLogin.status, 200);
  assert.match(forcedLogin.setCookie, /Max-Age=43200/);
  const forcedRow = await expiry(forcedLogin.cookie);
  assert.equal(forcedRow.expires_at - forcedRow.created_at, 43200000);

  const revoked = await member('persist_revoked');
  const revokedLogin = await login(revoked, true);
  assert.equal(revokedLogin.status, 200);
  const revokedId = revokedLogin.data.id;
  await f.db.prepare('UPDATE users SET credential_version=credential_version+1 WHERE id=?').bind(revokedId).run();
  assert.equal((await request('/api/account/me', 'GET', undefined, revokedLogin.cookie)).status, 401);
  assert.equal(await expiry(revokedLogin.cookie), null);
  const revokedRow = await f.db.prepare('SELECT end_reason FROM login_history WHERE user_id=?').bind(revokedId).first();
  assert.equal(revokedRow.end_reason, 'revoked');
}

test('local persistent login requires explicit boolean and remains revocable', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-persistent-session-test-'));
  const app = await createWhisperServer({ port: 0, dataDir: dir });
  try { await persistenceExercise({ url: app.localUrl, db: localStore(app.db) }); }
  finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Workers D1 persistent login requires explicit boolean and remains revocable', { timeout: 120000 }, async () => {
  const f = await cloudFixture();
  try { await persistenceExercise(f); } finally { await f.close(); }
});

test('0004 preserves existing data and the 0.5.4 session SQL contract', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of ['0001_initial.sql', '0002_accounts.sql', '0003_session_devices.sql']) {
      db.exec(readFileSync(new URL('../cloud/migrations/' + file, import.meta.url), 'utf8'));
    }
    const now = Date.now();
    for (const id of ['a', 'b']) db.prepare('INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, 'synthetic_' + id, 'public', 'salt', 'nonce', 'encrypted-vault', 'auth-salt', 'synthetic-verifier', now);
    db.prepare('INSERT INTO conversations(id,a,b,created_at,updated_at) VALUES(?,?,?,?,?)').run('conversation', 'a', 'b', now, now);
    db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,'text',?,?,?,?)")
      .run('message', 'conversation', 'a', 'nonce', 'synthetic-ciphertext', now, now + 60000);
    const insertSession = (token, id, at, expiry) => {
      db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,?)').run(token, 'a', at, expiry, 1);
      db.prepare('INSERT INTO session_devices(token_hash,public_id,method,device,ip) SELECT token_hash,?,?,?,? FROM sessions WHERE token_hash=?')
        .run(id, 'web', 'Synthetic browser', '192.0.2.1', token);
    };
    insertSession('synthetic-old-hash', 'old-public-id', now, now + 43200000);
    const snapshot = () => Object.fromEntries(['users', 'sessions', 'session_devices', 'conversations', 'messages', 'storage_totals'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    const before = snapshot(), columns = db.prepare('PRAGMA table_info(sessions)').all();
    db.exec('BEGIN');
    db.exec(readFileSync(new URL('../cloud/migrations/0004_login_history.sql', import.meta.url), 'utf8'));
    db.exec('COMMIT');
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare('PRAGMA table_info(sessions)').all(), columns);
    assert.equal(db.prepare('SELECT id FROM login_history').get().id, 'old-public-id');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM login_history').all()).includes('synthetic-old-hash'));
    insertSession('synthetic-new-hash', 'new-public-id', now + 1, now + 43200000);
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run('synthetic-new-hash');
    assert.equal(db.prepare('SELECT end_reason FROM login_history WHERE id=?').get('new-public-id').end_reason, 'revoked');
    insertSession('synthetic-expired-hash', 'expired-public-id', now - 60000, now - 1);
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run('synthetic-expired-hash');
    const expired = db.prepare('SELECT ended_at,end_reason FROM login_history WHERE id=?').get('expired-public-id');
    assert.equal(expired.end_reason, 'expired'); assert.equal(expired.ended_at, now - 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_devices').get().n, 1);
    assert.deepEqual(db.prepare('SELECT * FROM users').all(), before.users);
    assert.deepEqual(db.prepare('SELECT * FROM messages').all(), before.messages);
  } finally { db.close(); }
});
