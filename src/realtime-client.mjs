// Invalidation transport only. Message envelopes continue through the normal API.
export class RealtimeConnection {
  constructor({ request, url, onChange, onState = () => {}, WebSocketImpl = globalThis.WebSocket }) {
    this.request = request; this.url = url; this.onChange = onChange; this.onState = onState; this.WebSocketImpl = WebSocketImpl;
    this.running = false; this.epoch = 0; this.socket = null; this.state = 'closed'; this.attempt = 0;
    this.timers = new Set(); this.changePending = false; this.changeTask = null;
    this.lastReconnect = 0;
  }
  start() {
    if (this.running) return;
    this.running = true; this.epoch++; this.attempt = 0;
    this.#fallback(this.epoch); void this.#connect(this.epoch);
  }
  stop() {
    this.running = false; this.epoch++; this.changePending = false;
    this.#clearTimers(); this.#closeSocket(); this.#state('closed');
  }
  reconnect() {
    if (!this.running) { this.start(); return; }
    const now = Date.now();
    if (this.lastReconnect && now - this.lastReconnect < 1000) return;
    this.lastReconnect = now;
    this.epoch++; this.attempt = 0; this.#clearTimers(); this.#closeSocket();
    this.#fallback(this.epoch); this.#change(this.epoch); void this.#connect(this.epoch);
  }
  #state(value) { if (this.state !== value) { this.state = value; this.onState(value); } }
  #timer(callback, delay) {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, delay);
    this.timers.add(timer); return timer;
  }
  #cancel(timer) { if (timer != null) { clearTimeout(timer); this.timers.delete(timer); } }
  #clearTimers() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  #closeSocket() { const socket = this.socket; this.socket = null; try { socket?.close(); } catch {} }
  #current(epoch) { return this.running && this.epoch === epoch; }
  #change(epoch) {
    if (!this.#current(epoch)) return;
    this.changePending = true;
    if (this.changeTask) return;
    this.changeTask = (async () => {
      while (this.#current(epoch) && this.changePending) {
        this.changePending = false;
        try { await this.onChange(); } catch {}
      }
    })().finally(() => {
      this.changeTask = null;
      // A new generation may have requested sync while the old task was completing.
      if (this.running && this.changePending) this.#change(this.epoch);
    });
  }
  #fallback(epoch) {
    this.#timer(() => {
      if (!this.#current(epoch)) return;
      if (this.state !== 'open') this.#change(epoch);
      this.#fallback(epoch);
    }, 30_000 + Math.random() * 15_000);
  }
  #validate(epoch, socket) {
    this.#timer(() => {
      if (!this.#current(epoch) || this.socket !== socket || this.state !== 'open') return;
      this.#change(epoch); this.#validate(epoch, socket);
    }, 60_000 + Math.random() * 30_000);
  }
  #heartbeat(epoch, socket) {
    this.#timer(() => {
      if (!this.#current(epoch) || this.socket !== socket || this.state !== 'open') return;
      try { socket.send('ping'); }
      catch { this.#disconnect(epoch, socket); return; }
      this.pongTimer = this.#timer(() => this.#disconnect(epoch, socket), 45_000);
      this.#heartbeat(epoch, socket);
    }, 45_000);
  }
  #disconnect(epoch, socket) {
    if (!this.#current(epoch) || this.socket !== socket) return;
    this.#clearTimers(); this.#closeSocket(); this.#state('closed');
    this.#fallback(epoch); this.#retry(epoch);
  }
  #retry(epoch) {
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6) * (0.8 + Math.random() * 0.4));
    this.#timer(() => { if (this.#current(epoch)) void this.#connect(epoch); }, delay);
  }
  async #connect(epoch) {
    if (!this.#current(epoch)) return;
    this.#state('connecting');
    try {
      if (!this.WebSocketImpl) throw new Error('WebSocket unavailable');
      const { ticket, expiresAt } = await this.request('/api/realtime/ticket', 'POST');
      if (!this.#current(epoch)) return;
      if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(ticket) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid realtime ticket');
      const socket = new this.WebSocketImpl(this.url, ['whisper-realtime-v1', `ticket.${ticket}`]);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (!this.#current(epoch) || this.socket !== socket) return;
        this.attempt = 0; this.#state('open'); this.#change(epoch); this.#validate(epoch, socket); this.#heartbeat(epoch, socket);
      });
      socket.addEventListener('message', event => {
        if (!this.#current(epoch) || this.socket !== socket) return;
        if (event.data === 'pong') { this.#cancel(this.pongTimer); this.pongTimer = null; return; }
        if (typeof event.data !== 'string' || event.data.length > 128) return;
        try { const value = JSON.parse(event.data); if (value.version === 1 && (value.type === 'ready' || value.type === 'changed')) this.#change(epoch); } catch {}
      });
      socket.addEventListener('close', () => this.#disconnect(epoch, socket));
      socket.addEventListener('error', () => this.#disconnect(epoch, socket));
      this.#timer(() => { if (this.state === 'connecting') this.#disconnect(epoch, socket); }, 20_000);
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (error?.status === 401 || error?.status === 403) { this.stop(); return; }
      this.#state('closed'); this.#retry(epoch);
    }
  }
}
