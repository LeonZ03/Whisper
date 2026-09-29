import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxKeyring } from '../cli/linux-keyring.mjs';
import { ProtectedLoginStore } from '../cli/login-store.mjs';
import { WhisperClient } from '../cli/client.mjs';

function memoryKeyring() {
  const records = new Map(), calls = []; let locked = false;
  return { records, calls, lock: value => { locked = value; }, async run(args, input) {
    calls.push(args); const action = args[0], key = JSON.stringify(args.slice(action === 'store' ? 2 : 1));
    if (locked) return { code: 1, output: Buffer.alloc(0) };
    if (action === 'store') records.set(key, Buffer.from(input));
    if (action === 'clear') records.delete(key);
    return { code: action === 'lookup' && !records.has(key) ? 1 : 0, output: action === 'lookup' ? Buffer.from(records.get(key) || []) : Buffer.alloc(0) };
  } };
}
test('Linux keyring encrypts local login, binds origin/storage, rotates keys and cancels queued saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-keyring-'));
  const backend = memoryKeyring(), keyring = new LinuxKeyring(dir, backend.run);
  const store = new ProtectedLoginStore(dir, { platform: 'linux', keyring });
  const origin = 'https://synthetic.example', identity = { id: 'user', secretKey: 'synthetic-private-key', cookie: 'synthetic-cookie' };
  try {
    assert.equal(await store.available(), true); assert.equal(backend.records.size, 0);
    await store.save(origin, identity); const bytes = await readFile(store.path(origin));
    for (const value of Object.values(identity)) assert.equal(bytes.includes(Buffer.from(value)), false);
    assert.deepEqual(await store.load(origin), { v: 1, origin, ...identity });
    await writeFile(store.path('https://other.example'), bytes);
    await assert.rejects(store.load('https://other.example'));
    await assert.rejects(new LinuxKeyring(join(dir, 'other'), backend.run).open(bytes, origin));
    const tampered = JSON.parse(bytes); tampered.tag = Buffer.alloc(16).toString('base64');
    await writeFile(store.path(origin), JSON.stringify(tampered)); await assert.rejects(store.load(origin));
    await writeFile(store.path(origin), bytes); await store.save(origin, identity);
    assert.equal(backend.records.size, 1);
    const pending = store.save(origin, identity), clearing = store.clear(origin);
    assert.equal(await pending, false); await clearing;
    assert.equal(await store.load(origin), null); assert.equal(backend.records.size, 0);
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), []);
    for (const args of backend.calls) for (const secret of Object.values(identity)) assert.equal(args.includes(secret), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('locked Linux keyring keeps sealed login for retry; explicit logout removes it even while locked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-keyring-locked-'));
  const backend = memoryKeyring(), store = new ProtectedLoginStore(dir, { platform: 'linux', keyring: new LinuxKeyring(dir, backend.run) });
  const origin = 'https://synthetic.example', identity = { id: 'user', publicKey: Buffer.alloc(32, 1).toString('base64'), secretKey: Buffer.alloc(32, 2).toString('base64'), cookie: 'whisper_session=' + 'a'.repeat(43) };
  try {
    await store.save(origin, identity); const original = await readFile(store.path(origin)); backend.lock(true);
    assert.equal(await store.available(), false);
    const client = new WhisperClient({ server: origin, loginStore: store, fetchImpl: async () => Response.json({ id: identity.id, publicKey: identity.publicKey, username: 'synthetic', role: 'member' }) });
    assert.equal(await client.restoreSavedLogin(), false); assert.match(client.loginNotice, /密钥环/);
    assert.deepEqual(await readFile(store.path(origin)), original);
    backend.lock(false); assert.equal(await client.restoreSavedLogin(), true);
    backend.lock(true); await client.logout(); assert.equal(await store.load(origin), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
