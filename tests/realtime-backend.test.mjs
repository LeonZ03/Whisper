import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createWhisperServer } from '../server/app.mjs';
import { localStore } from '../accounts/local-store.mjs';
import { readSync, syncStatement, journalHigh, journalAudience, JOURNAL_AUDIENCE_SQL } from '../cloud/realtime-sync.mjs';
import { realtimeCloudFixture, migrationStatements } from './realtime-backend-fixture.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const base64 = n => Buffer.alloc(n, 1).toString('base64');
async function seed(db) {
  const users = [];
  for (const username of ['realtime_a', 'realtime_b', 'realtime_c']) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    await db.prepare("INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id, username, base64(32), base64(16), base64(24), base64(48), base64(16), base64(32), Date.now()).run();
    await db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,1)').bind(hash(token), id, Date.now(), Date.now() + 600000).run();
    users.push({ id, username, token, tokenHash: hash(token), cookie: 'whisper_session=' + token });
  }
  return users;
}
function request(f, user, path, method = 'GET', body = {}) {
  return fetch(f.url + path, { method, headers: { ...(user ? { Cookie: user.cookie } : {}), ...(method !== 'GET' ? { Origin: f.url, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
}
async function json(f, user, path, method = 'GET', body = {}) {
  const response = await request(f, user, path, method, body); assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
}
function track(ws) {
  const queue = [], waiting = [];
  ws.on('message', raw => { const text = raw.toString(); let value; try { value = JSON.parse(text); } catch { value = text; } const pending = waiting.find(w => w.predicate(value)); if (pending) { waiting.splice(waiting.indexOf(pending), 1); clearTimeout(pending.timer); pending.resolve(value); } else queue.push(value); });
  return { queue, next(predicate = () => true) { const index = queue.findIndex(predicate); if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]); return new Promise((resolve, reject) => { const pending = { predicate, resolve, timer: setTimeout(() => reject(Error('WebSocket response timed out')), 10000) }; waiting.push(pending); }); } };
}
async function connect(f, user, { origin, ticket } = {}) {
  const issued = ticket || (await json(f, user, '/api/realtime/ticket', 'POST')).ticket;
  const ws = new WebSocket(f.url.replace(/^http/, 'ws') + '/api/realtime', ['whisper-realtime-v1', 'ticket.' + issued], { ...(origin ? { origin } : {}) });
  const inbox = track(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  assert.equal(ws.protocol, 'whisper-realtime-v1');
  assert.deepEqual(await inbox.next(value => value?.type === 'ready'), { type: 'ready', version: 1 });
  return { ws, inbox, ticket: issued };
}
async function rejectedSocket(f, ticket, expected, origin) {
  const ws = new WebSocket(f.url.replace(/^http/, 'ws') + '/api/realtime', ['whisper-realtime-v1', 'ticket.' + ticket], { ...(origin ? { origin } : {}) });
  await new Promise((resolve, reject) => { ws.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, expected); response.resume(); ws.terminate(); resolve(); }); ws.on('error', () => {}); ws.once('open', () => { ws.terminate(); reject(Error('Unexpected successful connection')); }); });
}
function socketOutcome(f, ticket) {
  const ws = new WebSocket(f.url.replace(/^http/, 'ws') + '/api/realtime', ['whisper-realtime-v1', 'ticket.' + ticket]);
  const inbox = track(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ status: 101, ws, inbox }));
    ws.once('unexpected-response', (_request, response) => { response.resume(); const status = response.statusCode; ws.terminate(); resolve({ status }); });
    ws.on('error', () => {});
    ws.once('close', () => { /* Rejected handshakes close after their response. */ });
    const timer = setTimeout(() => { ws.terminate(); reject(Error('Handshake timed out')); }, 10000); timer.unref();
    ws.once('open', () => clearTimeout(timer)); ws.once('unexpected-response', () => clearTimeout(timer));
  });
}
function message(type = 'text') { return { id: randomUUID(), type, nonce: base64(24), ciphertext: base64(48), expiresAt: Date.now() + 600000 }; }

test('local realtime: protected ticket, hints, heartbeat, sync and server revocation', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-realtime-local-')), server = await createWhisperServer({ dataDir: dir, port: 0 });
  const f = { url: server.localUrl }, db = localStore(server.db), sockets = [];
  try {
    const [a, b, c] = await seed(db), conversation = await json(f, a, '/api/conversations', 'POST', { username: b.username });
    assert.equal((await json(f, a, '/api/health')).capabilities.includes('realtime-sync-v1'), true);
    const snapshot = await json(f, b, `/api/sync?conversationId=${conversation.id}`); assert.equal(snapshot.reset, true); assert.equal(snapshot.messages.length, 0);
    const receiver = await connect(f, b), outsider = await connect(f, c); sockets.push(receiver.ws, outsider.ws);
    await rejectedSocket(f, receiver.ticket, 401);
    const extra = await json(f, b, '/api/realtime/ticket', 'POST'); await rejectedSocket(f, extra.ticket, 403, 'https://wrong.invalid');
    receiver.ws.send('ping'); assert.equal(await receiver.inbox.next(v => v === 'pong'), 'pong');
    const sent = message(); await json(f, a, `/api/conversations/${conversation.id}/messages`, 'POST', sent);
    assert.deepEqual(await receiver.inbox.next(v => v?.type === 'changed'), { type: 'changed', version: 1 });
    const delta = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${snapshot.cursor}`);
    assert.equal(delta.reset, false); assert.deepEqual(delta.messages.map(m => m.id), [sent.id]); assert.equal(delta.conversations[0].id, conversation.id);
    const denied = await json(f, c, `/api/sync?conversationId=${conversation.id}`); assert.equal(denied.conversationId, null); assert.equal(denied.messages.length, 0);
    await json(f, a, `/api/messages/${sent.id}`, 'DELETE'); await receiver.inbox.next(v => v?.type === 'changed');
    const removed = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${delta.cursor}`); assert.deepEqual(removed.removed, [sent.id]);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(outsider.inbox.queue.some(v => v?.type === 'changed'), false);
    const closed = new Promise(resolve => receiver.ws.once('close', code => resolve(code)));
    await json(f, b, '/api/auth/logout', 'POST'); assert.equal(await closed, 1008);
    assert.equal((await request(f, b, '/api/sync')).status, 401);
    assert.equal((await request(f, a, '/api/sync?cursor=1.5')).status, 400);
  } finally { for (const ws of sockets) ws.terminate(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('real Workers/D1 SQLite DO: one-use, hibernation, audience, atomic images and journal pagination', { timeout: 120000 }, async t => {
  const f = await realtimeCloudFixture(), sockets = [];
  try {
    const [a, b, c] = await seed(f.db), conversation = await json(f, a, '/api/conversations', 'POST', { username: b.username });
    const before = await json(f, b, `/api/sync?conversationId=${conversation.id}`);
    const receiver = await connect(f, b, { origin: 'https://appassets.androidplatform.net' }), outsider = await connect(f, c); sockets.push(receiver.ws, outsider.ws);
    await rejectedSocket(f, receiver.ticket, 401);
    const issued = await json(f, b, '/api/realtime/ticket', 'POST');
    const outcomes = await Promise.all([socketOutcome(f, issued.ticket), socketOutcome(f, issued.ticket)]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [101, 401]);
    const winner = outcomes.find(outcome => outcome.status === 101); sockets.push(winner.ws); await winner.inbox.next(v => v?.type === 'ready'); winner.ws.terminate();
    assert.ok(issued.expiresAt > Date.now() && issued.expiresAt <= Date.now() + 60000);
    const namespace = await f.mf.getDurableObjectNamespace('REALTIME'), stub = namespace.get(namespace.idFromName('hub-v1'));
    const invalidExpiry = await stub.fetch(new Request('https://realtime.internal/ticket', { method: 'POST', body: JSON.stringify({ ticketHash: hash('expired-ticket'), tokenHash: b.tokenHash, expiresAt: Date.now() - 1 }) }));
    assert.equal(invalidExpiry.status, 400);
    await f.mf.unsafeEvictDurableObject('realtime-test', 'RealtimeHub', { name: 'hub-v1', webSockets: 'hibernate' });
    receiver.ws.send('ping'); assert.equal(await receiver.inbox.next(v => v === 'pong'), 'pong');
    const image = message('image'); await json(f, a, `/api/conversations/${conversation.id}/messages`, 'POST', image);
    await receiver.inbox.next(v => v?.type === 'changed');
    const claims = await Promise.all(Array.from({ length: 6 }, () => request(f, b, `/api/messages/${image.id}/open`, 'POST')));
    assert.equal(claims.filter(r => r.status === 200).length, 1); assert.equal(claims.filter(r => r.status === 410).length, 5);
    const claimed = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${before.cursor}`);
    assert.ok(claimed.messages[0].consumedAt); assert.equal(claimed.messages[0].nonce, null); assert.equal(claimed.messages[0].ciphertext, null);
    assert.equal(await f.db.prepare('SELECT * FROM image_payloads WHERE message_id=?').bind(image.id).first(), null);
    await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(outsider.inbox.queue.some(v => v?.type === 'changed'), false);
    const initial = claimed.cursor, now = Date.now();
    const inserts = Array.from({ length: 205 }, () => f.db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,'text',?,?,?,?)").bind(randomUUID(), conversation.id, a.id, base64(24), base64(48), now, now + 600000));
    const writes = await f.db.batch(inserts);
    const page = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${initial}`); assert.equal(page.more, true); assert.equal(page.messages.length, 200);
    const last = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${page.cursor}`); assert.equal(last.more, false); assert.equal(last.messages.length, 5);
    const measured = await syncStatement(f.db, { userId: b.id, tokenHash: b.tokenHash, selected: conversation.id, cursor: last.cursor }).all();
    assert.equal(JSON.parse(measured.results[0].payload).messages.length, 0);
    t.diagnostic(JSON.stringify({ emptyDelta: measured.meta, messageWrites: writes.reduce((sum, r) => ({ rowsRead: sum.rowsRead + (r.meta?.rows_read || 0), rowsWritten: sum.rowsWritten + (r.meta?.rows_written || 0) }), { rowsRead: 0, rowsWritten: 0 }) }));
    // With 200+ historical events, collect exactly one new event. This catches
    // SQLite choosing a/b covering indexes and scanning the retained journal.
    assert.ok((await f.db.prepare('SELECT COUNT(*) AS n FROM realtime_journal').first()).n >= 200);
    const audienceBefore = await journalHigh(f.db);
    await f.db.prepare("INSERT INTO realtime_journal(kind,entity_id,a) VALUES('account',?,?)").bind(a.id, a.id).run();
    let audienceResult;
    const meteredDb = { prepare(sql) { return { bind(...args) { return { async all() { audienceResult = await f.db.prepare(sql).bind(...args).all(); return audienceResult; } }; } }; } };
    assert.deepEqual(await journalAudience(meteredDb, audienceBefore), [a.id]);
    assert.ok(audienceResult.meta.rows_read < 10, `Audience read ${audienceResult.meta.rows_read} rows for one new event`);
    assert.equal(audienceResult.meta.rows_written, 0);
    const audiencePlan = await f.db.prepare('EXPLAIN QUERY PLAN ' + JOURNAL_AUDIENCE_SQL).bind(audienceBefore).all();
    assert.ok(audiencePlan.results.some(row => /SEARCH realtime_journal USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(row.detail)), JSON.stringify(audiencePlan.results));
    assert.equal(audiencePlan.results.some(row => /SCAN realtime_journal/.test(row.detail)), false);
    const duplicateBefore = await journalHigh(f.db);
    await f.db.prepare("INSERT INTO realtime_journal(kind,entity_id,a,b) VALUES('account',?,?,?)").bind(a.id, a.id, a.id).run();
    assert.deepEqual(await journalAudience(f.db, duplicateBefore), [a.id]);
    t.diagnostic(JSON.stringify({ audienceSingleNewEvent: audienceResult.meta, audiencePlan: audiencePlan.results }));
    await f.db.prepare('UPDATE conversations SET archived_at=? WHERE id=?').bind(Date.now(), conversation.id).run();
    const sealed = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${last.cursor}`); assert.equal(sealed.conversationId, null); assert.equal(sealed.reset, true); assert.equal(sealed.conversations.some(c => c.id === conversation.id), false);
    await f.db.prepare('UPDATE conversations SET archived_at=NULL,history_from_seq=(SELECT MAX(seq) FROM messages WHERE conversation_id=?) WHERE id=?').bind(conversation.id, conversation.id).run();
    const reopened = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${last.cursor}`); assert.equal(reopened.reset, true); assert.equal(reopened.conversationId, conversation.id); assert.equal(reopened.messages.length, 0);
    await f.db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(b.tokenHash).run();
    const closed = new Promise(resolve => receiver.ws.once('close', resolve));
    // Any successful account write invokes connection revalidation, including
    // writes which do not themselves produce a message journal event.
    await json(f, a, '/api/auth/logout', 'POST'); assert.equal(await closed, 1008);
    assert.equal((await request(f, b, '/api/sync')).status, 401);
  } finally { for (const ws of sockets) ws.terminate(); await f.close(); }
});

test('notification failure leaves committed send successful and delta recovers it', { timeout: 60000 }, async () => {
  const f = await realtimeCloudFixture({ entry: 'tests/realtime-backend-notification-failure-worker.mjs' });
  try {
    const [a, b] = await seed(f.db), conversation = await json(f, a, '/api/conversations', 'POST', { username: b.username });
    const before = await json(f, b, `/api/sync?conversationId=${conversation.id}`), sent = message();
    const response = await request(f, a, `/api/conversations/${conversation.id}/messages`, 'POST', sent);
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), { ok: true, id: sent.id });
    assert.ok(await f.db.prepare('SELECT id FROM messages WHERE id=?').bind(sent.id).first());
    const delta = await json(f, b, `/api/sync?conversationId=${conversation.id}&cursor=${before.cursor}`);
    assert.equal(delta.reset, false); assert.deepEqual(delta.messages.map(m => m.id), [sent.id]);
  } finally { await f.close(); }
});

test('additive migration keeps old D1 writers and DELETE RETURNING claim compatible', { timeout: 120000 }, async () => {
  const f = await realtimeCloudFixture({ through: 4 });
  try {
    const [a, b] = await seed(f.db), [left, right] = [a.id, b.id].sort(), id = randomUUID(), now = Date.now();
    await f.db.prepare('INSERT INTO conversations(id,a,b,created_at,updated_at) VALUES(?,?,?,?,?)').bind(id, left, right, now, now).run();
    const image = message('image');
    await f.db.batch([
      f.db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,created_at,expires_at) VALUES(?,?,?,'image',?,?)").bind(image.id, id, a.id, now, image.expiresAt),
      f.db.prepare('INSERT INTO image_payloads VALUES(?,?,?)').bind(image.id, image.nonce, image.ciphertext)
    ]);
    const before = await f.db.prepare('SELECT * FROM messages WHERE id=?').bind(image.id).first();
    await f.db.batch(migrationStatements(readFileSync('cloud/migrations/0005_realtime_journal.sql', 'utf8')).map(sql => f.db.prepare(sql)));
    assert.deepEqual(await f.db.prepare('SELECT * FROM messages WHERE id=?').bind(image.id).first(), before);
    const claims = await Promise.all(Array.from({ length: 4 }, () => f.db.prepare('DELETE FROM image_payloads WHERE message_id=? RETURNING nonce,ciphertext').bind(image.id).first()));
    assert.equal(claims.filter(Boolean).length, 1); assert.ok((await f.db.prepare('SELECT consumed_at FROM messages WHERE id=?').bind(image.id).first()).consumed_at);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM realtime_journal WHERE kind='message' AND entity_id=?").bind(image.id).first()).n, 1);
    const text = message(); await f.db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,'text',?,?,?,?)").bind(text.id, id, a.id, text.nonce, text.ciphertext, now, text.expiresAt).run();
    await f.db.prepare('DELETE FROM messages WHERE id=?').bind(text.id).run();
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM realtime_journal WHERE kind='remove' AND entity_id=?").bind(text.id).first()).n, 1);
    await f.db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,1)').bind(hash('old-worker-session'), a.id, now, now + 600000).run();
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').bind(a.id).first()).n, 2);
  } finally { await f.close(); }
});

test('local bounded journal resets old/ahead cursors and excludes sealed history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-journal-bound-')), server = await createWhisperServer({ dataDir: dir, port: 0 }), db = localStore(server.db);
  try {
    const [a, b] = await seed(db), [left, right] = [a.id, b.id].sort(), id = randomUUID(), now = Date.now();
    server.db.prepare('INSERT INTO conversations(id,a,b,created_at) VALUES(?,?,?,?)').run(id, left, right, now);
    const initial = await readSync(db, { userId: a.id, tokenHash: a.tokenHash, selected: id, cursor: null, local: true });
    server.db.exec('BEGIN IMMEDIATE');
    const insert = server.db.prepare("INSERT INTO realtime_journal(kind,entity_id,conversation_id,a,b) VALUES('conversation',?,?,?,?)");
    for (let i = 0; i < 10005; i++) insert.run(id, id, left, right);
    server.db.exec('COMMIT');
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM realtime_journal').get().n, 10000);
    const old = await readSync(db, { userId: a.id, tokenHash: a.tokenHash, selected: id, cursor: initial.cursor, local: true }); assert.equal(old.reset, true);
    const ahead = await readSync(db, { userId: a.id, tokenHash: a.tokenHash, selected: id, cursor: old.cursor + 10, local: true }); assert.equal(ahead.reset, true);
    const m = message(); server.db.prepare("INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,'text',?,?,?,?)").run(m.id, id, a.id, m.nonce, m.ciphertext, now, m.expiresAt);
    server.db.prepare('UPDATE conversations SET history_from_seq=(SELECT MAX(seq) FROM messages WHERE conversation_id=?) WHERE id=?').run(id, id);
    const view = await readSync(db, { userId: b.id, tokenHash: b.tokenHash, selected: id, cursor: null, local: true }); assert.equal(view.messages.length, 0);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
