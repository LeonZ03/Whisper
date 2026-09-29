import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedLoginStore } from '../cli/login-store.mjs';
import { WhisperClient } from '../cli/client.mjs';
import { createWhisperServer } from '../server/app.mjs';
import { prepareEnrollment } from '../src/account-client.mjs';
import { LinuxKeyring, runSecretTool } from '../cli/linux-keyring.mjs';

test('Windows DPAPI seals identity, binds origin, rejects tampering and clears queued saves', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-dpapi-'));
  const origin = 'https://synthetic.example', identity = { id: 'synthetic-user', secretKey: 'private-synthetic-identity', cookie: 'synthetic-session-cookie' };
  const store = new ProtectedLoginStore(dir);
  try {
    assert.equal(await store.available(), true);
    assert.equal(await store.save(origin, identity), true);
    const file = store.path(origin), bytes = await readFile(file);
    for (const value of Object.values(identity)) assert.equal(bytes.includes(Buffer.from(value)), false);
    assert.deepEqual(await new ProtectedLoginStore(dir).load(origin), { v: 1, origin, ...identity });
    await writeFile(store.path('https://other.example'), bytes);
    await assert.rejects(store.load('https://other.example'));
    bytes[bytes.length - 8] ^= 1; await writeFile(file, bytes); await assert.rejects(store.load(origin));
    const pending = store.save(origin, identity), clearing = store.clear(origin);
    assert.equal(await pending, false); await clearing; assert.equal(await store.load(origin), null);
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI protected restart retains one session, explicit logout and revocation clear it', { skip: process.platform !== 'win32' && !(process.platform === 'linux' && process.env.WHISPER_TEST_SECRET_TOOL), timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-persistent-cli-'));
  const app = await createWhisperServer({ port: 0, dataDir: join(dir, 'server') });
  const store = new ProtectedLoginStore(join(dir, 'client'), { keyring: process.platform === 'linux' ? new LinuxKeyring(join(dir, 'client'), (args, input) => runSecretTool(args, input, process.env.WHISPER_TEST_SECRET_TOOL)) : undefined });
  const fresh = () => new WhisperClient({ server: app.localUrl, loginStore: store });
  let client = fresh();
  try {
    const username = 'durable_cli', password = 'Synthetic9!';
    await client.request('/api/auth/register', 'POST', { username, ...await prepareEnrollment(password) });
    app.db.prepare("UPDATE users SET status='active' WHERE username=?").run(username);
    await client.authenticate({ username, password });
    const key = client.user.secretKey, id = client.user.id;
    assert.equal(client.persistentLogin, true); assert.equal(app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
    await client.suspend(); assert.ok(key.every(value => value === 0)); assert.equal(client.user, null);
    client = fresh(); assert.equal(await client.restoreSavedLogin(), true); assert.equal(client.user.id, id);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM login_history').get().n, 1);
    await client.logout(); assert.equal(await store.load(app.localUrl), null); assert.equal(app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
    await client.authenticate({ username, password }); await client.suspend();
    app.db.prepare('UPDATE users SET credential_version=credential_version+1 WHERE id=?').run(id);
    client = fresh(); assert.equal(await client.restoreSavedLogin(), false); assert.equal(client.user, null); assert.equal(await store.load(app.localUrl), null);
  } finally { await client.logout().catch(() => {}); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a late CLI restore cannot revive memory after explicit logout; offline retains sealed login', async () => {
  const saved = { id: 'synthetic', publicKey: Buffer.alloc(32, 1).toString('base64'), secretKey: Buffer.alloc(32, 2).toString('base64'), cookie: 'whisper_session=' + 'a'.repeat(43) };
  let record = saved, resolveMe;
  const loginStore = { load: async () => record, clear: async () => { record = null; } };
  const gate = new Promise(resolve => { resolveMe = resolve; });
  const client = new WhisperClient({ server: 'https://example.invalid', loginStore, fetchImpl: async url => url.endsWith('/me') ? gate : Response.json({ ok: true }) });
  const restoring = client.restoreSavedLogin();
  while (!client.cookie) await new Promise(resolve => setTimeout(resolve, 5));
  await client.logout(); resolveMe(Response.json({ ...saved, username: 'synthetic', role: 'member' }));
  assert.equal(await restoring, false); assert.equal(client.user, null); assert.equal(record, null);
  record = saved; client.fetchImpl = async () => { throw Error('offline'); };
  await assert.rejects(client.restoreSavedLogin(), /连接中断/); assert.equal(record, saved); assert.equal(client.cookie, '');
});
