import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import worker from '../cloud/worker.mjs';
import { localStore } from '../accounts/local-store.mjs';

export const RATE_ORIGIN = 'https://rate-test.whisper.invalid';
export const RATE_IP = '198.51.100.10';
export const sha = text => createHash('sha256').update(text).digest('hex');
const b64 = size => Buffer.alloc(size, 1).toString('base64');

// Real Worker routing and real SQLite statements. Only Cloudflare's external
// limiter and DO transport bindings are controlled substitutes in this fixture.
export function createRateFixture(capacities = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_initial.sql', '0002_accounts.sql', '0003_session_devices.sql', '0004_login_history.sql', '0005_realtime_journal.sql']) {
    sqlite.exec(readFileSync(new URL('../cloud/migrations/' + name, import.meta.url), 'utf8'));
  }
  const trace = [], pending = [], base = localStore(sqlite);
  function statement(sql, args = []) {
    const target = () => base.prepare(sql).bind(...args);
    return {
      bind: (...values) => statement(sql, values),
      first() { trace.push({ type: 'db', operation: 'first', sql }); return target().first(); },
      all() { trace.push({ type: 'db', operation: 'all', sql }); return target().all(); },
      run() { trace.push({ type: 'db', operation: 'run', sql }); return target().run(); },
      execute() { trace.push({ type: 'db', operation: 'execute', sql }); return target().execute(); }
    };
  }
  const db = {
    prepare: statement,
    batch: statements => base.batch(statements),
    withSession(mode) { trace.push({ type: 'session', mode }); return db; }
  };
  const limiters = {};
  for (const name of ['COARSE_LIMIT', 'API_LIMIT', 'AUTH_LIMIT', 'SEND_LIMIT', 'CONNECT_LIMIT', 'CONNECT_IP_LIMIT']) {
    let capacity = capacities[name] ?? 1000;
    const counts = new Map(), keys = [];
    limiters[name] = {
      keys,
      reset(next = capacity) { capacity = next; counts.clear(); keys.length = 0; },
      async limit({ key }) {
        trace.push({ type: 'limit', binding: name, key }); keys.push(key);
        const count = (counts.get(key) || 0) + 1; counts.set(key, count);
        return { success: count <= capacity };
      }
    };
  }
  const hubRequests = [];
  const env = {
    DB: db, ENVIRONMENT: 'test', AUTH_PEPPER: 'a'.repeat(64), INSTANCE_ID: 'isolated-rate-test',
    ALLOWED_ORIGINS: RATE_ORIGIN, ...limiters,
    REALTIME: {
      idFromName: name => name,
      get: () => ({ async fetch(request) {
        const path = new URL(request.url).pathname;
        trace.push({ type: 'hub', path }); hubRequests.push(path);
        // These tests exercise admission and refusal. Successful WebSocket
        // upgrades/hibernation are covered by realtime-backend.test.mjs.
        return new Response(null, { status: path === '/connect' ? 401 : 204 });
      } })
    }
  };
  const users = [];
  for (const username of ['rate_alice', 'rate_bobby']) {
    const user = { id: randomUUID(), username };
    sqlite.prepare('INSERT INTO users(id,username,public_key,salt,vault_nonce,vault_cipher,auth_salt,auth_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(user.id, username, b64(32), b64(16), b64(24), b64(48), b64(16), b64(32), Date.now());
    users.push(user);
  }
  function session(user) {
    const token = randomBytes(32).toString('base64url'), tokenHash = sha(token);
    sqlite.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,credential_version) VALUES(?,?,?,?,1)')
      .run(tokenHash, user.id, Date.now(), Date.now() + 600000);
    return { ...user, tokenHash, cookie: 'whisper_session=' + token };
  }
  const [alice, bobby] = users.map(session), aliceAgain = session(users[0]);
  const conversationId = randomUUID(), [a, b] = users.map(u => u.id).sort();
  sqlite.prepare('INSERT INTO conversations(id,a,b,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(conversationId, a, b, Date.now(), Date.now());
  function message() {
    return { id: randomUUID(), type: 'text', nonce: b64(24), ciphertext: b64(48), expiresAt: Date.now() + 600000 };
  }
  async function request(path, { user, ip = RATE_IP, method = 'GET', body = {}, headers = {} } = {}) {
    const request = new Request(RATE_ORIGIN + path, {
      method,
      headers: { 'CF-Connecting-IP': ip, ...(user ? { Cookie: user.cookie } : {}),
        ...(method !== 'GET' ? { Origin: RATE_ORIGIN, 'Content-Type': 'application/json', 'X-Whisper-Request': '1' } : {}), ...headers },
      ...(method !== 'GET' ? { body: JSON.stringify(body) } : {})
    });
    const response = await worker.fetch(request, env, { waitUntil: promise => pending.push(promise) });
    await Promise.all(pending.splice(0));
    return response;
  }
  async function close() { await Promise.all(pending.splice(0)); sqlite.close(); }
  return { sqlite, db, env, trace, limiters, hubRequests, alice, aliceAgain, bobby, conversationId, message, request, close };
}
