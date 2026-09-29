import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RealtimeHub } from '../cloud/realtime.mjs';
import { createRateFixture, RATE_IP, RATE_ORIGIN, sha } from './realtime-rate-limit-fixture.mjs';

async function status(response, expected) {
  assert.equal(response.status, expected);
  if (expected === 429) {
    assert.equal(response.headers.get('Retry-After'), '60');
    assert.equal(typeof (await response.json()).error, 'string');
  }
}
const calls = (f, binding) => f.limiters[binding].keys;

test('same-IP authenticated API limits are per account, including separate sessions', async () => {
  const f = createRateFixture({ API_LIMIT: 1 });
  try {
    await status(await f.request('/api/conversations', { user: f.alice }), 200);
    await status(await f.request('/api/conversations', { user: f.aliceAgain }), 429);
    await status(await f.request('/api/conversations', { user: f.bobby }), 200);
    assert.deepEqual(calls(f, 'API_LIMIT'), ['api-user:' + f.alice.id, 'api-user:' + f.alice.id, 'api-user:' + f.bobby.id]);
    assert.deepEqual(calls(f, 'COARSE_LIMIT'), Array(3).fill(sha('coarse-ip:' + RATE_IP)));
  } finally { await f.close(); }
});

test('anonymous API limits share their IP bucket and cannot become user buckets with forged cookies', async () => {
  const f = createRateFixture({ API_LIMIT: 1 });
  try {
    await status(await f.request('/api/conversations'), 401);
    await status(await f.request('/api/conversations', { headers: { Cookie: 'whisper_session=' + 'z'.repeat(43) } }), 429);
    await status(await f.request('/api/conversations', { ip: '198.51.100.11' }), 401);
    assert.deepEqual(calls(f, 'API_LIMIT'), [sha('api-anonymous:' + RATE_IP), sha('api-anonymous:' + RATE_IP), sha('api-anonymous:198.51.100.11')]);
    await status(await f.request('/api/conversations', { user: f.alice }), 200);
    assert.equal(calls(f, 'API_LIMIT').at(-1), 'api-user:' + f.alice.id);
  } finally { await f.close(); }
});

test('authentication admission uses IP even across usernames and authenticated accounts', async () => {
  const f = createRateFixture({ AUTH_LIMIT: 1 });
  try {
    await status(await f.request('/api/auth/salt?username=' + f.alice.username, { user: f.alice }), 200);
    await status(await f.request('/api/auth/salt?username=' + f.bobby.username, { user: f.bobby }), 429);
    await status(await f.request('/api/auth/salt?username=' + f.bobby.username, { ip: '198.51.100.11' }), 200);
    assert.deepEqual(calls(f, 'AUTH_LIMIT'), [sha('auth-ip:' + RATE_IP), sha('auth-ip:' + RATE_IP), sha('auth-ip:198.51.100.11')]);
    // Successful authenticated logout is a user API operation, not an auth-IP
    // admission attempt. Other people using this IP must not block logout.
    await status(await f.request('/api/auth/logout', { user: f.alice, method: 'POST' }), 200);
    assert.equal(calls(f, 'AUTH_LIMIT').length, 3);
  } finally { await f.close(); }
});

test('message admission uses sender account and rejects before the message INSERT', async () => {
  const f = createRateFixture({ SEND_LIMIT: 1 });
  try {
    const path = `/api/conversations/${f.conversationId}/messages`;
    const sent = f.message();
    await status(await f.request(path, { user: f.alice, method: 'POST', body: sent }), 201);
    const before = f.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    const rejected = f.message(), traceStart = f.trace.length;
    await status(await f.request(path, { user: f.aliceAgain, method: 'POST', body: rejected }), 429);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
    assert.equal(f.sqlite.prepare('SELECT id FROM messages WHERE id=?').get(rejected.id), undefined);
    assert.equal(f.trace.slice(traceStart).some(entry => entry.type === 'db' && /INSERT INTO messages/i.test(entry.sql)), false);
    await status(await f.request(path, { user: f.bobby, method: 'POST', body: f.message() }), 201);
    assert.deepEqual(calls(f, 'SEND_LIMIT'), ['sender:' + f.alice.id, 'sender:' + f.alice.id, 'sender:' + f.bobby.id]);
  } finally { await f.close(); }
});

test('ticket admission uses account, rejects before DO issue, and shares across sessions', async () => {
  const f = createRateFixture({ CONNECT_LIMIT: 1 });
  try {
    await status(await f.request('/api/realtime/ticket', { user: f.alice, method: 'POST' }), 200);
    assert.equal(f.hubRequests.filter(path => path === '/ticket').length, 1);
    await status(await f.request('/api/realtime/ticket', { user: f.aliceAgain, method: 'POST' }), 429);
    assert.equal(f.hubRequests.filter(path => path === '/ticket').length, 1);
    await status(await f.request('/api/realtime/ticket', { user: f.bobby, method: 'POST' }), 200);
    assert.deepEqual(calls(f, 'CONNECT_LIMIT'), ['connect-user:' + f.alice.id, 'connect-user:' + f.alice.id, 'connect-user:' + f.bobby.id]);
    assert.deepEqual(calls(f, 'CONNECT_IP_LIMIT'), []);
  } finally { await f.close(); }
});

test('WebSocket handshake coarse connection limits are by IP and reject before the hub', async () => {
  const f = createRateFixture({ CONNECT_IP_LIMIT: 1 });
  try {
    const headers = { Upgrade: 'websocket', Origin: RATE_ORIGIN, 'Sec-WebSocket-Protocol': 'whisper-realtime-v1, ticket.' + 't'.repeat(43) };
    await status(await f.request('/api/realtime', { headers }), 401); // Controlled DO refusal.
    assert.equal(f.hubRequests.length, 1);
    const traceStart = f.trace.length;
    await status(await f.request('/api/realtime', { user: f.alice, headers }), 429);
    assert.equal(f.hubRequests.length, 1);
    // withSession constructs a consistency handle; it does not query D1.
    assert.equal(f.trace.slice(traceStart).some(entry => entry.type === 'db'), false);
    await status(await f.request('/api/realtime', { ip: '198.51.100.11', headers }), 401);
    assert.deepEqual(calls(f, 'CONNECT_IP_LIMIT'), [sha('connect-ip:' + RATE_IP), sha('connect-ip:' + RATE_IP), sha('connect-ip:198.51.100.11')]);
    assert.deepEqual(calls(f, 'API_LIMIT'), []);
  } finally { await f.close(); }
});

test('coarse API refusal precedes any DB session/query for valid or forged credential-shaped cookies', async () => {
  const f = createRateFixture({ COARSE_LIMIT: 0 });
  try {
    await status(await f.request('/api/conversations', { user: f.alice }), 429);
    await status(await f.request('/api/auth/salt?username=' + f.alice.username, { headers: { Cookie: 'whisper_session=' + 'z'.repeat(43) } }), 429);
    assert.equal(f.trace.some(entry => entry.type === 'db' || entry.type === 'session'), false);
    assert.equal(f.hubRequests.length, 0);
    for (const name of ['API_LIMIT', 'AUTH_LIMIT', 'SEND_LIMIT', 'CONNECT_LIMIT', 'CONNECT_IP_LIMIT']) assert.deepEqual(calls(f, name), []);
    assert.deepEqual(f.trace.map(entry => entry.type), ['limit', 'limit']);
  } finally { await f.close(); }
});

test('real DO handshake handler keys authenticated admission by user before allocating a socket', async () => {
  const f = createRateFixture({ CONNECT_LIMIT: 0 }), tickets = new DatabaseSync(':memory:');
  tickets.exec('CREATE TABLE tickets(hash TEXT PRIMARY KEY,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL)');
  // No socket or constructor simulation: invoke the actual admission handler
  // with real SQLite DELETE RETURNING and reject before platform socket creation.
  const hub = Object.create(RealtimeHub.prototype);
  let socketInspections = 0;
  hub.env = f.env;
  hub.state = {
    storage: { sql: { exec(sql, ...args) { const results = tickets.prepare(sql).all(...args); return { toArray: () => results }; } } },
    getWebSockets() { socketInspections++; throw Error('Denied handshake inspected sockets'); }
  };
  try {
    for (const [index, user] of [f.alice, f.aliceAgain, f.bobby].entries()) {
      const ticket = String(index + 1).repeat(43);
      tickets.prepare('INSERT INTO tickets VALUES(?,?,?)').run(sha(ticket), user.tokenHash, Date.now() + 60000);
      const response = await hub.fetch(new Request('https://realtime.internal/connect', { headers: { 'Sec-WebSocket-Protocol': 'whisper-realtime-v1, ticket.' + ticket } }));
      assert.equal(response.status, 429);
      assert.equal(tickets.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
    }
    assert.deepEqual(calls(f, 'CONNECT_LIMIT'), ['handshake-user:' + f.alice.id, 'handshake-user:' + f.alice.id, 'handshake-user:' + f.bobby.id]);
    assert.equal(socketInspections, 0);
    assert.equal(f.trace.filter(entry => entry.type === 'session').every(entry => entry.mode === 'first-primary'), true);
  } finally { tickets.close(); await f.close(); }
});
