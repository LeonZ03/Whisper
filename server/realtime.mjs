import { WebSocketServer } from 'ws';
import { randomBytes, createHash } from 'node:crypto';
import { REALTIME_PROTOCOL, realtimeOrigin, ticketFromProtocols } from '../cloud/realtime.mjs';
import { SESSION_VALID_SQL } from '../cloud/realtime-sync.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
export function localRealtime({ db, originFor, rate }) {
  const tickets = new Map(), clients = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64, handleProtocols: protocols => protocols.has(REALTIME_PROTOCOL) ? REALTIME_PROTOCOL : false });
  const valid = tokenHash => db.prepare(SESSION_VALID_SQL).get(tokenHash, Date.now());
  function issue(tokenHash) {
    if (!valid(tokenHash)) { const error = new Error('登录已失效，请重新登录。'); error.status = 401; throw error; }
    for (const [key, record] of tickets) if (record.expiresAt <= Date.now()) tickets.delete(key);
    const existing = [...tickets.entries()].filter(([, record]) => record.tokenHash === tokenHash);
    while (existing.length >= 4) tickets.delete(existing.shift()[0]);
    if (tickets.size >= 4000) { const error = new Error('实时连接繁忙。'); error.status = 429; throw error; }
    const ticket = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 60000;
    tickets.set(hash(ticket), { tokenHash, expiresAt });
    return { ticket, expiresAt };
  }
  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      try {
        if (new URL(req.url, 'http://localhost').pathname !== '/api/realtime' || req.method !== 'GET') throw Object.assign(new Error(), { status: 404 });
        // Express helpers are unavailable on the HTTP upgrade request.
        req.get = name => req.headers[name.toLowerCase()];
        const origin = originFor(req);
        if (!origin) throw Object.assign(new Error(), { status: 403 });
        rate(req, 'coarse', 1200);
        realtimeOrigin(req.get('origin'), origin);
        const ticket = ticketFromProtocols(req.get('sec-websocket-protocol')), key = hash(ticket), record = tickets.get(key);
        tickets.delete(key);
        if (!record || record.expiresAt <= Date.now()) throw Object.assign(new Error(), { status: 401 });
        const actor = valid(record.tokenHash);
        if (!actor) throw Object.assign(new Error(), { status: 401 });
        req.userId = actor.id; rate(req, 'connect', 30);
        const entries = [...clients.values()];
        if (entries.filter(c => c.tokenHash === record.tokenHash).length >= 4 || entries.filter(c => c.userId === actor.id).length >= 16) throw Object.assign(new Error(), { status: 429 });
        wss.handleUpgrade(req, socket, head, ws => {
          clients.set(ws, { userId: actor.id, tokenHash: record.tokenHash });
          ws.on('close', () => clients.delete(ws)); ws.on('error', () => clients.delete(ws));
          ws.on('message', (message, binary) => {
            if (!valid(record.tokenHash)) { ws.close(1008, 'Session ended'); return; }
            if (!binary && message.toString() === 'ping') ws.send('pong');
            else ws.close(1008, 'Unsupported message');
          });
          ws.send(JSON.stringify({ type: 'ready', version: 1 }));
        });
      } catch (error) {
        socket.end(`HTTP/1.1 ${error.status || 500} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
    });
  }
  function notify(userIds = [], { revalidateAll = false } = {}) {
    const audience = new Set(userIds);
    for (const [ws, data] of clients) {
      try {
        if (!revalidateAll && !audience.has(data.userId)) continue;
        const actor = valid(data.tokenHash);
        if (!actor || actor.id !== data.userId) ws.close(1008, 'Session ended');
        else if (audience.has(actor.id)) ws.send(JSON.stringify({ type: 'changed', version: 1 }));
      } catch { try { ws.close(1011, 'Session check unavailable'); } catch {} }
    }
  }
  function close() { tickets.clear(); for (const ws of clients.keys()) ws.terminate(); clients.clear(); wss.close(); }
  return { issue, attach, notify, close };
}
