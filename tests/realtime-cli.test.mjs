import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhisperClient } from '../cli/client.mjs';
import { ChatApplication } from '../cli/application.mjs';
import { createWhisperServer } from '../server/app.mjs';

const conversation = (id = 'conversation-1') => ({ id, peer: { id: 'peer-1', username: 'peer', publicKey: 'peer-key' } });
const message = (id, seq, overrides = {}) => ({ id, seq, conversationId: 'conversation-1', expiresAt: Date.now() + 60_000, ...overrides });
const response = ({ cursor, reset = false, conversations = [], messages = [], removed = [], removedConversations = [], more = false, conversationId = 'conversation-1' }) => ({
  version: 1, cursor, reset, more, conversationId, conversations, removedConversations, messages, removed, serverTime: Date.now(),
});

function clientWith(payloads) {
  const client = new WhisperClient({ server: 'http://127.0.0.1:8787' });
  client.user = { id: 'self', username: 'self', publicKey: 'self-key', secretKey: new Uint8Array(32) };
  client.selected = conversation(); client.supportsRealtime = true; client.trust = () => ({ blocked: false });
  const calls = [];
  client.request = async (path) => { calls.push(path); return payloads.shift(); };
  return { client, calls };
}

test('realtime snapshots reset the cursor; incremental updates deduplicate and preserve loaded older history', async () => {
  const { client, calls } = clientWith([
    response({ cursor: 10, reset: true, conversations: [conversation()], messages: [message('latest', 10), message('image', 2, { type: 'image', consumedAt: null }), message('expired', 11, { expiresAt: Date.now() - 1 })] }),
    response({ cursor: 11, more: true, conversations: [{ ...conversation(), title: 'updated' }], messages: [message('latest', 10, { text: 'updated' }), message('image', 2, { type: 'image', consumedAt: Date.now() })], removed: ['gone'] }),
    response({ cursor: 12, conversations: [], messages: [message('new', 12)] }),
  ]);
  await client.sync();
  client.messages = [message('older', 1), ...client.messages, message('gone', 9)];
  await client.sync();
  assert.deepEqual(calls, ['/api/sync?conversationId=conversation-1', '/api/sync?conversationId=conversation-1&cursor=10', '/api/sync?conversationId=conversation-1&cursor=11']);
  assert.deepEqual(client.messages.map((item) => item.id), ['older', 'image', 'latest', 'new']);
  assert.equal(client.messages.find((item) => item.id === 'latest').text, 'updated');
  assert.ok(client.messages.find((item) => item.id === 'image').consumedAt);
  assert.equal(client.conversations[0].title, 'updated');
  assert.equal(client.syncCursor, 12);
});

test('a response for a conversation that is no longer selected cannot change messages or cursor', async () => {
  let release;
  const client = new WhisperClient({ server: 'http://127.0.0.1:8787' });
  client.user = { id: 'self', username: 'self', publicKey: 'self-key', secretKey: new Uint8Array(32) };
  client.selected = conversation(); client.supportsRealtime = true; client.trust = () => ({ blocked: false });
  client.messages = [message('keep', 4)];
  client.request = () => new Promise((resolve) => { release = resolve; });
  const pending = client.syncIncremental();
  client.selected = conversation('conversation-2');
  release(response({ cursor: 88, reset: true, conversations: [conversation()], messages: [message('stale', 88)] }));
  assert.equal(await pending, false);
  assert.equal(client.syncCursor, null);
  assert.deepEqual(client.messages.map((item) => item.id), ['keep']);
});

test('a stale request cannot apply after the authenticated account changes', async () => {
  let release;
  const client = new WhisperClient({ server: 'http://127.0.0.1:8787' });
  client.user = { id: 'old-user', username: 'old', publicKey: 'key', secretKey: new Uint8Array(32) };
  client.selected = conversation(); client.supportsRealtime = true; client.trust = () => ({ blocked: false });
  client.messages = [message('keep', 4)];
  client.request = () => new Promise((resolve) => { release = resolve; });
  const pending = client.syncIncremental();
  client.user = { id: 'new-user', username: 'new', publicKey: 'new-key', secretKey: new Uint8Array(32) };
  client.loginEpoch++;
  release(response({ cursor: 88, reset: true, conversations: [conversation()], messages: [message('stale', 88)] }));
  assert.equal(await pending, false);
  assert.equal(client.syncCursor, null);
  assert.deepEqual(client.messages.map((item) => item.id), ['keep']);
});

test('overlapping same-cursor syncs serialize and cannot restore a message after its deletion', async () => {
  const client = new WhisperClient({ server: 'http://127.0.0.1:8787' });
  client.user = { id: 'self', username: 'self', publicKey: 'self-key', secretKey: new Uint8Array(32) };
  client.selected = conversation(); client.supportsRealtime = true; client.trust = () => ({ blocked: false });
  const requests = [];
  client.request = (path) => new Promise((resolve) => requests.push({ path, resolve }));
  const first = client.syncIncremental();
  const second = client.syncIncremental();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  requests[0].resolve(response({ cursor: 10, reset: true, conversations: [conversation()], messages: [message('to-delete', 1)] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, '/api/sync?conversationId=conversation-1&cursor=10');
  requests[1].resolve(response({ cursor: 11, conversations: [], removed: ['to-delete'] }));
  await Promise.all([first, second]);
  assert.equal(client.syncCursor, 11);
  assert.deepEqual(client.messages, []);
});

test('conversation selection resets the cursor and pinned identity changes clear messages', async () => {
  const { client, calls } = clientWith([response({ cursor: 2, reset: true, conversations: [conversation('conversation-2')], messages: [message('sensitive', 2)], conversationId: 'conversation-2' })]);
  client.syncCursor = 99; client.syncConversationId = 'conversation-1'; client.selected = conversation('conversation-2');
  client.trust = () => ({ blocked: true });
  client.messages = [message('old', 1)];
  await client.syncIncremental();
  assert.equal(calls[0], '/api/sync?conversationId=conversation-2');
  assert.equal(client.syncCursor, 2);
  assert.deepEqual(client.messages, []);
});

test('recent window stays at 200 until older history is explicitly loaded, then deltas span it', async () => {
  const recent = Array.from({ length: 200 }, (_, index) => message(`m${index + 1}`, index + 1001));
  const { client } = clientWith([response({ cursor: 10, reset: true, conversations: [conversation()], messages: recent })]);
  await client.sync();
  assert.equal(client.messages.length, 200);
  client.supportsHistory = true; client.hasOlder = true;
  client.request = async (path) => {
    if (path.includes('/history?')) return { messages: [message('m0', 1)], hasMore: false };
    return response({ cursor: 11, conversations: [], removed: ['m0'], messages: [message('m201', 1201)] });
  };
  assert.equal(await client.loadOlder(), 1);
  assert.equal(client.historyExpanded, true);
  await client.sync();
  assert.equal(client.messages.length, 201);
  assert.equal(client.messages.some((item) => item.id === 'm0'), false);
  assert.equal(client.messages.some((item) => item.id === 'm1'), true);
  assert.equal(client.messages.some((item) => item.id === 'm201'), true);
});

test('401 revocation clears in-memory identity and stops realtime', async () => {
  const client = new WhisperClient({ server: 'http://127.0.0.1:8787', fetchImpl: async () => Response.json({ error: 'revoked' }, { status: 401 }) });
  const secretKey = new Uint8Array(32).fill(7); let cleared = false, stopped = false;
  client.user = { id: 'self', username: 'self', publicKey: 'key', secretKey };
  client.selected = conversation(); client.messages = [message('secret', 1)]; client.cookie = 'whisper_session=abc';
  client.syncCursor = 4; client.syncConversationId = 'conversation-1';
  client.loginStore = { clear: async () => { cleared = true; } };
  client.realtime = { stop: () => { stopped = true; } };
  await assert.rejects(client.request('/api/sync'), (error) => error.status === 401);
  assert.equal(client.user, null); assert.equal(client.cookie, ''); assert.deepEqual(client.messages, []);
  assert.equal(client.syncCursor, null);
  assert.ok(secretKey.every((byte) => byte === 0)); assert.equal(cleared, true); assert.equal(stopped, true);
});

test('application timer keeps rendering but leaves all realtime polling to the controller', async () => {
  let syncCalls = 0, renders = 0;
  const ui = { on() {}, set() { renders++; }, pending: null };
  const client = { server: 'http://127.0.0.1:8787', user: null, selected: null, messages: [], connected: false, ttl: '24h', hasOlder: false,
    realtime: {}, sync: async () => { syncCalls++; }, trust: () => ({ blocked: false, verified: false }) };
  const app = new ChatApplication(client, ui);
  await app.tick();
  assert.equal(syncCalls, 0); assert.equal(renders, 1);
});

test('a change notification during an in-flight application sync queues a follow-up delta', async () => {
  let finishFirst, syncCalls = 0;
  const ui = { on() {}, set() {}, pending: null };
  const client = { server: 'http://127.0.0.1:8787', user: { id: 'self' }, loginEpoch: 1, selected: null, messages: [], connected: true, ttl: '24h', hasOlder: false, pollIntervalMs: 2000,
    trust: () => ({ blocked: false, verified: false }), sync: () => { syncCalls++; return syncCalls === 1 ? new Promise((resolve) => { finishFirst = resolve; }) : Promise.resolve(); } };
  const app = new ChatApplication(client, ui);
  const initial = app.synchronize();
  await new Promise((resolve) => setImmediate(resolve));
  const notification = app.synchronize();
  finishFirst();
  await Promise.all([initial, notification]);
  assert.equal(syncCalls, 2);
});

test('a change notification during older-page loading queues a delta after the page', async () => {
  let finishOlder, syncCalls = 0;
  const ui = { on() {}, set() {}, pending: null };
  const client = { server: 'http://127.0.0.1:8787', user: { id: 'self' }, loginEpoch: 1, selected: null, messages: [], connected: true, ttl: '24h', hasOlder: true, pollIntervalMs: 2000,
    trust: () => ({ blocked: false, verified: false }), loadOlder: () => new Promise((resolve) => { finishOlder = resolve; }), sync: async () => { syncCalls++; } };
  const app = new ChatApplication(client, ui);
  const loading = app.loadPrevious();
  const notification = app.synchronize();
  finishOlder(1);
  await Promise.all([loading, notification]);
  assert.equal(syncCalls, 1);
});

test('local server WebSocket notification triggers a CLI delta sync', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cli-realtime-'));
  const app = await createWhisperServer({ dataDir: join(dir, 'db'), port: 0 });
  const a = new WhisperClient({ server: app.localUrl }), b = new WhisperClient({ server: app.localUrl });
  const password = 'Rt2026!';
  let received;
  const messageReceived = new Promise((resolve) => { received = resolve; });
  try {
    for (const [client, username] of [[a, 'rt_alice'], [b, 'rt_bobby']]) {
      await client.authenticate({ username, password, register: true });
      app.db.prepare("UPDATE users SET status='active' WHERE username=? AND status='pending'").run(username);
      await client.authenticate({ username, password });
    }
    await a.chat('rt_bobby'); await b.chat('rt_alice');
    await a.health(); await a.sync();
    assert.equal(a.startRealtime({ onChange: async () => {
      await a.sync();
      if (a.viewMessages().some((item) => item.text === 'websocket delivery')) received();
    } }), true);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket did not open')), 5000);
      const poll = () => { if (a.realtime?.state === 'open') { clearTimeout(timeout); resolve(); } else setTimeout(poll, 20); };
      poll();
    });
    await b.send('websocket delivery');
    let timeout;
    await Promise.race([messageReceived, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('change notification was not synced')), 5000); })]);
    clearTimeout(timeout);
    assert.equal(a.viewMessages().at(-1).text, 'websocket delivery');
  } finally {
    await Promise.all([a, b].map((client) => client.logout().catch(() => {})));
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
});
