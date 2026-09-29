import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeConnection } from '../src/realtime-client.mjs';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(t, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
  const sockets = [], states = [], calls = [], changes = [];
  class Socket extends EventTarget {
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.sent = []; sockets.push(this); }
    open() { this.dispatchEvent(new Event('open')); }
    message(data) { const event = new Event('message'); Object.defineProperty(event, 'data', { value: data }); this.dispatchEvent(event); }
    send(value) { this.sent.push(value); }
    close() { this.closed = true; this.dispatchEvent(new Event('close')); }
  }
  const connection = new RealtimeConnection({ url: 'wss://whisper.test/api/realtime', WebSocketImpl: Socket,
    request: async (...args) => { calls.push(args); return { ticket: 'T'.repeat(43), expiresAt: Date.now() + 60_000 }; },
    onState: state => states.push(state), onChange: async () => changes.push(1), ...overrides });
  t.after(() => connection.stop());
  return { connection, sockets, states, calls, changes };
}

test('ticket stays in subprotocol; open and changed notifications serialize and coalesce', async t => {
  let release, running = 0, maximum = 0, changeCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { onChange: async () => { maximum = Math.max(maximum, ++running); changeCalls++; if (changeCalls === 1) await gate; running--; } });
  f.connection.start(); f.connection.start(); await flush();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], ['/api/realtime/ticket', 'POST']);
  const socket = f.sockets[0];
  assert.equal(socket.url, 'wss://whisper.test/api/realtime');
  assert.deepEqual(socket.protocols, ['whisper-realtime-v1', 'ticket.' + 'T'.repeat(43)]);
  socket.open(); socket.message('{"type":"ready","version":1}');
  for (let i = 0; i < 25; i++) socket.message('{"type":"changed","version":1}');
  socket.message('{"type":"changed","version":2}'); socket.message('invalid');
  assert.equal(changeCalls, 1); release(); await flush();
  assert.equal(changeCalls, 2); assert.equal(maximum, 1);
  assert.deepEqual(f.states, ['connecting', 'open']);
  f.connection.stop(); assert.equal(socket.closed, true); assert.equal(f.connection.timers.size, 0);
  t.mock.timers.tick(500_000); await flush(); assert.equal(f.calls.length, 1); assert.equal(changeCalls, 2);
});

test('stopped ticket requests and old socket callbacks cannot revive a connection', async t => {
  let resolveTicket;
  const f = fixture(t, { request: () => new Promise(resolve => { resolveTicket = resolve; }) });
  f.connection.start(); f.connection.stop();
  resolveTicket({ ticket: 'T'.repeat(43), expiresAt: Date.now() + 60_000 }); await flush();
  assert.equal(f.sockets.length, 0); assert.equal(f.connection.state, 'closed');
});

test('open validation is low frequency, heartbeats do not trigger synchronization', async t => {
  const f = fixture(t); f.connection.start(); await flush(); const socket = f.sockets[0]; socket.open(); await flush();
  t.mock.timers.tick(44_999); await flush(); assert.equal(f.changes.length, 1);
  t.mock.timers.tick(1); await flush(); assert.deepEqual(socket.sent, ['ping']);
  socket.message('pong'); assert.equal(f.changes.length, 1);
  t.mock.timers.tick(29_999); await flush(); assert.equal(f.changes.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(f.changes.length, 2);
  assert.equal(f.calls.length, 1);
});

test('missing pong closes transport and reconnects with a new one-time ticket', async t => {
  const f = fixture(t); f.connection.start(); await flush(); const old = f.sockets[0]; old.open(); await flush();
  t.mock.timers.tick(45_000); await flush(); assert.deepEqual(old.sent, ['ping']);
  t.mock.timers.tick(45_000); await flush(); assert.equal(old.closed, true); assert.equal(f.connection.state, 'closed');
  t.mock.timers.tick(1000); await flush(); assert.equal(f.sockets.length, 2); assert.equal(f.calls.length, 2);
  old.message('{"type":"changed","version":1}'); await flush(); assert.equal(f.changes.length, 2);
  f.sockets[1].open(); await flush(); assert.equal(f.connection.state, 'open'); assert.equal(f.changes.length, 3);
});

test('disconnected fallback is 30–45 seconds and reconnect requests do not storm', async t => {
  const f = fixture(t, { request: async () => { throw Error('offline'); } });
  f.connection.start(); await flush();
  t.mock.timers.tick(37_499); await flush(); assert.equal(f.changes.length, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(f.changes.length, 1);
  f.connection.reconnect(); f.connection.reconnect(); await flush(); assert.equal(f.changes.length, 2);
  f.connection.stop(); assert.equal(f.connection.timers.size, 0);
});

test('expired authentication stops retries and timers', async t => {
  let calls = 0;
  const f = fixture(t, { request: async () => { calls++; throw Object.assign(Error('revoked'), { status: 401 }); } });
  f.connection.start(); await flush(); assert.equal(f.connection.running, false); assert.equal(f.connection.state, 'closed');
  assert.equal(f.connection.timers.size, 0); t.mock.timers.tick(500_000); await flush(); assert.equal(calls, 1);
});
