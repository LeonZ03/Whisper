import { digest, fail } from './security.mjs';
import { SESSION_VALID_SQL, journalAudience } from './realtime-sync.mjs';

export const REALTIME_PROTOCOL = 'whisper-realtime-v1';
export function realtimeOrigin(origin, allowedOrigin) {
  if (origin && origin !== allowedOrigin && origin !== 'https://appassets.androidplatform.net') fail(403, '连接来源校验失败。');
}
export function ticketFromProtocols(value) {
  const protocols = (value || '').split(',').map(s => s.trim());
  const tickets = protocols.filter(s => /^ticket\.[A-Za-z0-9_-]{43}$/.test(s));
  if (!protocols.includes(REALTIME_PROTOCOL) || tickets.length !== 1 || protocols.length !== 2) fail(400, '无效的实时连接票据。');
  return tickets[0].slice(7);
}
function primary(env) { return env.DB.withSession ? env.DB.withSession('first-primary') : env.DB; }
export async function validRealtimeSession(env, tokenHash) {
  return primary(env).prepare(SESSION_VALID_SQL).bind(tokenHash, Date.now()).first();
}
export function realtimeHub(env) {
  if (!env.REALTIME) fail(503, '实时连接尚未配置。');
  return env.REALTIME.get(env.REALTIME.idFromName('hub-v1'));
}
export async function notifyRealtime(env, db, after, { revalidateAll = false } = {}) {
  const users = await journalAudience(db, after);
  await realtimeHub(env).fetch(new Request('https://realtime.internal/notify', { method: 'POST', body: JSON.stringify({ users, revalidateAll }) }));
}

// One shared hub carries invalidation hints only. Durable attachments contain
// hashes and public IDs, never cookie tokens, keys or message contents.
export class RealtimeHub {
  constructor(state, env) {
    this.state = state; this.env = env;
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,token_hash TEXT NOT NULL,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS tickets_session ON tickets(token_hash,expires_at)');
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/ticket' && request.method === 'POST') {
      const { ticketHash, tokenHash, expiresAt } = await request.json();
      if (!/^[a-f0-9]{64}$/.test(ticketHash || '') || !/^[a-f0-9]{64}$/.test(tokenHash || '') || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 60000) return new Response(null, { status: 400 });
      if (!await validRealtimeSession(this.env, tokenHash)) return new Response(null, { status: 401 });
      this.state.storage.sql.exec('DELETE FROM tickets WHERE expires_at<=?', Date.now());
      this.state.storage.sql.exec('INSERT INTO tickets VALUES(?,?,?)', ticketHash, tokenHash, expiresAt);
      this.state.storage.sql.exec('DELETE FROM tickets WHERE token_hash=? AND hash NOT IN (SELECT hash FROM tickets WHERE token_hash=? ORDER BY expires_at DESC,rowid DESC LIMIT 4)', tokenHash, tokenHash);
      return new Response(null, { status: 204 });
    }
    if (path === '/connect') {
      const ticket = ticketFromProtocols(request.headers.get('Sec-WebSocket-Protocol'));
      // Synchronous DELETE RETURNING consumes once even when authorization awaits.
      const rows = this.state.storage.sql.exec('DELETE FROM tickets WHERE hash=? RETURNING token_hash,expires_at', await digest(ticket)).toArray();
      const record = rows[0];
      if (!record || record.expires_at <= Date.now()) return new Response(null, { status: 401 });
      const actor = await validRealtimeSession(this.env, record.token_hash);
      if (!actor) return new Response(null, { status: 401 });
      if (this.env.CONNECT_LIMIT && !(await this.env.CONNECT_LIMIT.limit({ key: 'handshake-user:' + actor.id })).success) return new Response(null, { status: 429 });
      const connections = this.state.getWebSockets().map(ws => ({ ws, data: ws.deserializeAttachment() }));
      if (connections.filter(c => c.data?.tokenHash === record.token_hash).length >= 4 || connections.filter(c => c.data?.userId === actor.id).length >= 16) return new Response(null, { status: 429 });
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      server.serializeAttachment({ userId: actor.id, tokenHash: record.token_hash });
      this.state.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'ready', version: 1 }));
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': REALTIME_PROTOCOL } });
    }
    if (path === '/notify' && request.method === 'POST') {
      const { users, revalidateAll } = await request.json(), audience = new Set(Array.isArray(users) ? users : []);
      const sessions = new Map();
      // Revalidate all existing connections after account writes; target only
      // authorized recipients of committed journal changes for invalidation.
      for (const ws of this.state.getWebSockets()) {
        const data = ws.deserializeAttachment();
        try {
          if (!data?.tokenHash) { ws.close(1008, 'Session ended'); continue; }
          if (!revalidateAll && !audience.has(data.userId)) continue;
          let pending = sessions.get(data.tokenHash);
          if (!pending) { pending = validRealtimeSession(this.env, data.tokenHash); sessions.set(data.tokenHash, pending); }
          const actor = await pending;
          if (!actor || actor.id !== data.userId) ws.close(1008, 'Session ended');
          else if (audience.has(actor.id)) ws.send(JSON.stringify({ type: 'changed', version: 1 }));
        } catch { try { ws.close(1011, 'Session check unavailable'); } catch {} }
      }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  async webSocketMessage(ws, message) {
    // ping/pong uses the hibernating auto responder; other input is unsupported.
    if (message !== 'ping') ws.close(1008, 'Unsupported message');
  }
  async webSocketClose(ws, code) { try { ws.close(code); } catch {} }
  async webSocketError(ws) { try { ws.close(1011, 'Connection error'); } catch {} }
}
