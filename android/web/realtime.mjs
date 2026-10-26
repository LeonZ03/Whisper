import { RealtimeConnection } from '../../src/realtime-client.mjs';

// Native owns tickets, heartbeat and reconnect even while WebView is suspended.
// JS receives only state/revision and repairs the encrypted view when visible.
const listeners = new Set();
globalThis.whisperAndroidRealtimeEvent = state => {
  for (const listener of listeners) listener(state);
};
export class AndroidRealtimeConnection {
  constructor({ user, onChange, onState, request, url, bridge = globalThis.WhisperNative }) {
    Object.assign(this, { user, onChange, onState, request, url, bridge });
    this.running = false; this.paused = false; this.epoch = 0; this.revision = -1;
    this.backgroundIntent = 0; this.pendingBackground = null;
    this.backgroundRevision = -1; this.backgroundValue = null;
    this.listener = state => this.accept(state);
  }
  async snapshot() {
    try { return JSON.parse(await this.bridge.realtimeState()); } catch { return null; }
  }
  async start() {
    if (this.running) return;
    this.running = true; const epoch = ++this.epoch; listeners.add(this.listener);
    const state = await this.snapshot();
    if (!this.running || epoch !== this.epoch) return;
    if (state?.suppressed) this.accept(state, true);
    else {
      this.bridge.startRealtime(this.user.id, this.user.publicKey);
      this.accept(await this.snapshot());
    }
    this.repair();
  }
  accept(state, initial = false) {
    if (!this.running || !state || (!initial && state.userId !== this.user.id)) return;
    // Events/snapshots can be queued across a rapid toggle. During an explicit
    // user operation, only a native state matching that latest intent is current.
    if (this.pendingBackground !== null && Boolean(state.suppressed) !== this.pendingBackground) return;
    const backgroundRevision = Number.isSafeInteger(state.backgroundRevision) ? state.backgroundRevision : 0;
    if (backgroundRevision < this.backgroundRevision) return;
    if (this.backgroundValue !== null && backgroundRevision === this.backgroundRevision
        && Boolean(state.suppressed) !== this.backgroundValue) return;
    if (state.revoked && !initial) { globalThis.whisperAndroidSessionRevoked?.(); return; }
    this.suppressed = Boolean(state.suppressed);
    this.backgroundRevision = backgroundRevision; this.backgroundValue = this.suppressed;
    this.open = state.state === 'open';
    globalThis.whisperAndroidBackgroundState?.(!this.suppressed);
    if (this.suppressed) {
      if (!this.paused && !this.fallback) {
        this.fallback = new RealtimeConnection({ request: this.request, url: this.url,
          onChange: () => { if (!this.paused) return this.onChange(); }, onState: this.onState });
        this.fallback.start();
      }
      return;
    }
    this.fallback?.stop(); this.fallback = null;
    this.onState(state.state === 'open' ? 'open' : 'connecting');
    if (Number.isSafeInteger(state.revision) && state.revision !== this.revision) {
      this.revision = state.revision;
      if (!this.paused) void this.onChange();
    }
  }
  repair() {
    clearTimeout(this.timer);
    if (!this.running || this.paused) return;
    const epoch = this.epoch;
    this.timer = setTimeout(async () => {
      try {
        await this.refreshNative(epoch);
        if (!this.paused && this.running && epoch === this.epoch && !this.fallback) await this.onChange();
      } finally {
        if (this.running && epoch === this.epoch) this.repair();
      }
    }, this.open ? 60_000 + Math.random() * 30_000 : 30_000 + Math.random() * 15_000);
  }
  async refreshNative(epoch = this.epoch) {
    let state = await this.snapshot();
    if (!this.running || this.paused || epoch !== this.epoch) return;
    // Initial validation / foreground service startup can fail transiently.
    // Retry only on the existing bounded foreground repair cadence, never in background.
    if (state?.userId === this.user.id && !state.suppressed && !state.revoked && state.state === 'stopped') {
      this.bridge.startRealtime(this.user.id, this.user.publicKey);
      state = await this.snapshot();
    }
    if (this.running && !this.paused && epoch === this.epoch) this.accept(state, state?.suppressed === true);
  }
  pause() { this.paused = true; clearTimeout(this.timer); this.fallback?.stop(); this.fallback = null; }
  async resume() {
    this.paused = false; const epoch = this.epoch;
    await this.refreshNative(epoch);
    if (this.running && epoch === this.epoch) {
      this.repair();
    }
  }
  async enableBackground(enabled) {
    if (!this.running) return false;
    const intent = ++this.backgroundIntent;
    const desired = Boolean(enabled);
    this.pendingBackground = !desired;
    globalThis.whisperAndroidBackgroundState?.(desired);
    if (!desired) {
      this.bridge.stopRealtime();
      const state = await this.snapshot();
      if (intent !== this.backgroundIntent || !this.running) return false;
      if (state?.suppressed) { this.accept(state); this.pendingBackground = null; return true; }
      this.pendingBackground = null;
      globalThis.whisperAndroidBackgroundState?.(!this.suppressed);
      return false;
    }
    // A stop may still be completing in Android. Retry after its owner has
    // released the service; startRealtime itself synchronously clears the
    // persisted opt-out, so this loop waits only for lifecycle ownership.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (intent !== this.backgroundIntent || !this.running) return false;
      let state = await this.snapshot();
      if (intent !== this.backgroundIntent || !this.running) return false;
      if (state?.userId === this.user.id && state.suppressed) {
        this.bridge.startRealtime(this.user.id, this.user.publicKey);
        state = await this.snapshot();
        if (intent !== this.backgroundIntent || !this.running) return false;
      } else if (!state || state.userId !== this.user.id) {
        this.bridge.startRealtime(this.user.id, this.user.publicKey);
        state = await this.snapshot();
      } else if (state.stopping || (state.state === 'stopped' && !state.suppressed)) {
        if (!state.stopping) this.bridge.startRealtime(this.user.id, this.user.publicKey);
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      if (state?.userId === this.user.id && !state.suppressed && !state.stopping) {
        this.accept(state); this.pendingBackground = null;
        this.backgroundRevision = Number.isSafeInteger(state.backgroundRevision) ? state.backgroundRevision : this.backgroundRevision;
        this.backgroundValue = false; return true;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (intent === this.backgroundIntent) {
      this.pendingBackground = null;
      globalThis.whisperAndroidBackgroundState?.(!this.suppressed);
    }
    return false;
  }
  stop() {
    this.running = false; this.epoch++; clearTimeout(this.timer); listeners.delete(this.listener);
    this.fallback?.stop(); this.fallback = null;
    // Explicit account teardown clears the native session separately. Avoid
    // turning logout into a persisted opt-out of background connection.
  }
}
