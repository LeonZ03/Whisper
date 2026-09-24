import { stripVTControlCharacters } from 'node:util';
// All untrusted text is sanitized BEFORE layout or decoration. Only this fixed palette emits SGR.
export function safeText(value) {
  return stripVTControlCharacters(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
const STYLES = Object.freeze({
  normal: '', muted: '2', title: '1', accent: '36', command: '1;36',
  self: '1;36', peer: '1;32', success: '32', warning: '33', error: '31',
  key: '1', selected: '1;7', secret: '2',
});
export function colorsEnabled(output, env = process.env, mode = 'auto') {
  if (!['auto', 'always', 'never'].includes(mode)) throw new Error('Invalid color mode');
  if (!output?.isTTY || mode === 'never') return false;
  if (mode === 'always') return true;
  if (Object.hasOwn(env, 'NO_COLOR') || Object.hasOwn(env, 'NODE_DISABLE_COLORS') || env.FORCE_COLOR === '0' || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  try { if (typeof output.hasColors === 'function') return output.hasColors(16, env); } catch {}
  return true;
}
export class TerminalTheme {
  constructor(output, { env = process.env, mode = 'auto' } = {}) { this.enabled = colorsEnabled(output, env, mode); }
  get reset() { return this.enabled ? '\x1b[0m' : ''; }
  paint(role, value) {
    const text = safeText(value), code = Object.hasOwn(STYLES, role) ? STYLES[role] : '';
    return this.enabled && code && text ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
  // UI-owned hints may highlight commands. Chat message bodies NEVER use this formatter.
  ui(value, base = 'normal') {
    const text = safeText(value); let result = '', end = 0;
    const tokens = /\/[a-z]+\b|Ctrl\+[A-Za-z]+|PgUp|PgDn|PageUp|PageDown|Enter|Tab|Esc|↑↓/g;
    for (const match of text.matchAll(tokens)) {
      result += this.paint(base, text.slice(end, match.index));
      result += this.paint(match[0][0] === '/' ? 'command' : 'key', match[0]);
      end = match.index + match[0].length;
    }
    return result + this.paint(base, text.slice(end));
  }
  header(text, sourceIndex, state) {
    text = safeText(text);
    if (sourceIndex === 0) return this.paint('command', text);
    if (sourceIndex === 1) return this.paint('muted', text);
    if (sourceIndex === 2) {
      let result = '', end = 0;
      for (const match of text.matchAll(/@[a-z0-9_]+|已连接|离线 \/ 重连中/g)) {
        result += this.paint('muted', text.slice(end, match.index));
        const role = match[0][0] === '@' ? (match[0] === '@' + state.selfName ? 'self' : 'peer') : state.connected ? 'success' : 'warning';
        result += this.paint(role, match[0]); end = match.index + match[0].length;
      }
      return result + this.paint('muted', text.slice(end));
    }
    if (sourceIndex === 3 && state.securityRole) {
      const split = text.indexOf('  ·  ');
      if (split >= 0) return this.paint(state.securityRole, text.slice(0, split)) + this.ui(text.slice(split), 'muted');
    }
    return this.ui(text, 'muted');
  }
  body(text, style, part, kind) {
    if (style?.role === 'ui') return this.ui(text, 'muted');
    if (style?.role === 'message') {
      if (part !== 0) return this.paint('muted', text);
      const split = text.indexOf('  '), end = split < 0 ? text.length : split;
      return this.paint(style.own ? 'self' : 'peer', text.slice(0, end)) + this.paint('muted', text.slice(end));
    }
    if (style?.role) return this.paint(style.role, text);
    return kind === 'chat' ? this.paint('normal', text) : this.ui(text, 'muted');
  }
  input(text, { secret, command } = {}) {
    if (secret) return this.paint('secret', text);
    const token = command && /^\/[a-z]*/i.exec(text);
    return token ? this.paint('command', token[0]) + this.paint('normal', text.slice(token[0].length)) : this.paint('normal', text);
  }
}

// A display-only countdown derived from the message's original absolute expiry.
export function remainingTime(expiresAt, now = Date.now()) {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return '期限未知';
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (!seconds) return '已到期';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const clock = [hours, minutes, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return `剩余 ${days ? days + '天 ' : ''}${clock}`;
}
