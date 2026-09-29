import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createWhisperServer } from '../server/app.mjs';
import { localStore } from '../accounts/local-store.mjs';
import { cloudFixture } from './cloud-fixture.mjs';
import { APP_SESSION_EXPIRES_AT, sessionDevice } from '../accounts/session-devices.mjs';

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
  const request = async (path, method = 'GET', body, cookie, extra = {}) => {
    const response = await fetch(f.url + path, { method, headers: {
      ...(method === 'GET' ? {} : { Origin: f.url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' }),
      ...(cookie ? { Cookie: cookie } : {}), ...extra
    }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
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
  assert.deepEqual(new Set(list.data.sessions.map(row => row.method)), new Set(['web', 'app', 'cli']));
  const current = list.data.sessions.find(row => row.current);
  assert.equal(current.method, 'app'); assert.equal(current.device, 'OPPO PKB110 / Android 15');
  assert.equal(current.ip, cloud ? '203.0.113.8' : '127.0.0.1');
  assert.equal(list.data.sessions.find(row => row.method === 'web').device, 'Edge / Windows');
  assert.equal((await request('/api/account/sessions', 'GET', undefined, other.cookie)).data.sessions.length, 1);
  assert.equal((await request('/api/account/sessions')).status, 401);
  for (const row of list.data.sessions) {
    assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'current', 'device', 'expiresAt', 'id', 'ip', 'method']);
    for (const cookie of [web.cookie, app.cookie, cli.cookie]) { assert.notEqual(row.id, cookie.split('=')[1]); assert.notEqual(row.id, cookieHash(cookie)); }
  }
  // A resumed app checks the existing session rather than issuing a second one.
  for (let i = 0; i < 3; i++) assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie)).status, 200);
  assert.equal((await first('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?', appRow.user_id)).n, 3);
  await run('UPDATE sessions SET expires_at=? WHERE token_hash=?', Date.now() - 1, cookieHash(web.cookie));
  assert.equal((await request('/api/account/me', 'GET', undefined, web.cookie)).status, 401);
  assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie)).status, 200);
  assert.equal((await request('/api/account/sessions', 'GET', undefined, app.cookie)).data.sessions.length, 2);
  // Explicit old-style INSERT has no side-table row, and stays identifiable as unknown.
  const legacyToken = randomBytes(32).toString('base64url'), legacyCookie = `whisper_session=${legacyToken}`;
  await run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,?)', hash(legacyToken), appRow.user_id, Date.now(), Date.now() + 43200000, appRow.credential_version);
  const legacy = (await request('/api/account/sessions', 'GET', undefined, legacyCookie)).data.sessions.find(row => row.current);
  assert.equal(legacy.method, 'unknown'); assert.equal(legacy.ip, 'unknown'); assert.equal(legacy.device, '未知设备'); assert.notEqual(legacy.id, hash(legacyToken));
  assert.equal((await request('/api/auth/logout', 'POST', {}, cli.cookie)).status, 200);
  assert.equal(await first('SELECT * FROM session_devices WHERE token_hash=?', cookieHash(cli.cookie)), null);
  await run('UPDATE users SET credential_version=credential_version+1 WHERE id=?', appRow.user_id);
  assert.equal((await request('/api/account/me', 'GET', undefined, app.cookie)).status, 401);
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

test('local session devices, durable app expiry and account isolation', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-session-test-'));
  let app = await createWhisperServer({ port: 0, dataDir: dir });
  try {
    const restartLogin = await exercise({ url: app.localUrl, db: localStore(app.db) }, false);
    const before = app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    await app.close(); app = await createWhisperServer({ port: 0, dataDir: dir });
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM session_devices').get().n, 8);
    const resumed = await fetch(app.localUrl + '/api/account/me', { headers: { Cookie: restartLogin.cookie } });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).id, restartLogin.data.id);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Workers D1 session devices preserve legacy compatibility and revocation', { timeout: 120000 }, async () => {
  const f = await cloudFixture();
  try { await exercise(f, true); } finally { await f.close(); }
});
