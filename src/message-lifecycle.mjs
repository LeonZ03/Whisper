// Presentation only: absolute expiry remains part of the existing encrypted envelope.
export function remainingLabel(expiresAt, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (!Number.isFinite(seconds)) return { seconds: 0, text: '已到期' };
  const days = Math.floor(seconds / 86400), rest = seconds % 86400;
  const pad = (n) => String(n).padStart(2, '0');
  return { seconds, text: `剩余 ${days ? days + '天 ' : ''}${pad(Math.floor(rest / 3600))}:${pad(Math.floor(rest / 60) % 60)}:${pad(rest % 60)}` };
}
export class MessageLifecycle {
  constructor(box, onRetire = () => {}) {
    this.box = box; this.onRetire = onRetire;
    this.entries = new Map(); this.fading = new Map(); this.interval = null;
  }
  track(id, element, expiresAt, countdown, consumed = false) {
    this.entries.set(id, { element, expiresAt, countdown, consumed });
    if (!this.interval) this.interval = setInterval(() => this.tick(), 250);
    this.tick();
  }
  tick({ animate = !document.hidden } = {}) {
    const now = Date.now();
    for (const [id, item] of this.entries) {
      if (!Number.isSafeInteger(item.expiresAt) || item.expiresAt <= now) {
        this.retire(id, 'expired', animate); continue;
      }
      if (!item.countdown || item.consumed) continue;
      const value = remainingLabel(item.expiresAt, now);
      if (item.countdown.dataset.seconds === String(value.seconds)) continue;
      item.countdown.dataset.seconds = String(value.seconds);
      item.countdown.textContent = value.text;
      item.countdown.classList.toggle('expiring-soon', value.seconds <= 60);
      item.countdown.classList.toggle('expiring-now', value.seconds <= 10);
    }
    if (!this.entries.size) { clearInterval(this.interval); this.interval = null; }
  }
  keepScroll(action) {
    const box = this.box, top = box.scrollTop;
    const bottom = box.scrollHeight - top - box.clientHeight < 40;
    const edge = box.getBoundingClientRect().top;
    const anchor = [...box.children].find((el) => !el.classList.contains('message-retiring') && el.getBoundingClientRect().bottom > edge);
    const before = anchor?.getBoundingClientRect().top;
    action();
    if (bottom) box.scrollTop = box.scrollHeight;
    else if (anchor?.isConnected) box.scrollTop += anchor.getBoundingClientRect().top - before;
    else box.scrollTop = top;
  }
  retire(id, reason = 'deleted', animate = !document.hidden) {
    const item = this.entries.get(id); if (!item) return;
    this.entries.delete(id);
    const el = item.element, rect = el.getBoundingClientRect();
    // Erase content and event-handler closures before any decorative animation.
    el.replaceChildren(); el.removeAttribute('title');
    el.classList.add('message-retiring'); el.dataset.removalReason = reason;
    el.setAttribute('aria-hidden', 'true'); el.inert = true;
    this.onRetire(id);
    const done = () => {
      const timer = this.fading.get(id); if (timer) clearTimeout(timer);
      this.fading.delete(id); this.keepScroll(() => el.remove()); this.emptyState();
    };
    if (!animate || !el.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    const shell = document.createElement('div'); shell.className = 'message-expired-shell';
    shell.textContent = reason === 'expired' ? '消息已到期' : '消息已删除';
    el.append(shell); el.style.minHeight = `${rect.height}px`; el.style.width = `${rect.width}px`;
    // The animation contains only the empty shell, never the expired text or image.
    el.addEventListener('animationend', done, { once: true });
    this.fading.set(id, setTimeout(done, 340));
  }
  reconcile(ids, pageFloor = 0) {
    for (const [id, item] of this.entries) {
      if (!ids.has(id)) {
        const expired = item.expiresAt <= Date.now();
        const outsidePage = !expired && Number(item.element.dataset.seq) < pageFloor;
        this.retire(id, expired ? 'expired' : 'deleted', !outsidePage && !document.hidden);
      }
    }
  }
  emptyState() {
    if (!this.entries.size && !this.fading.size && !this.box.querySelector('.messages-empty')) {
      const empty = document.createElement('p'); empty.className = 'messages-empty';
      empty.textContent = '这里还没有消息。\n发出的内容会先在你的浏览器加密。'; this.box.append(empty);
    }
  }
  clear() {
    clearInterval(this.interval); this.interval = null;
    for (const timer of this.fading.values()) clearTimeout(timer);
    this.fading.clear(); this.entries.clear(); this.box.replaceChildren();
  }
}
