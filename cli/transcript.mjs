import { TTL, normalizeServer } from './client.mjs';
const SIMPLE = new Set(['/login', '/register', '/chats', '/safety', '/clear', '/refresh', '/web', '/logout', '/help', '/quit']);
// Only syntactically valid commands are eligible for in-memory recall.
export function historyCommand(command, argument) {
  if (SIMPLE.has(command)) return argument ? null : command;
  if (command === '/chat' && /^[a-z0-9_]{3,24}$/i.test(argument)) return command + ' ' + argument;
  if (command === '/ttl' && Object.hasOwn(TTL, argument)) return command + ' ' + argument;
  if (command === '/delete' && /^#?[1-9]\d{0,14}$/.test(argument)) return command + ' ' + argument;
  if (command === '/server') {
    try { return command + ' ' + normalizeServer(argument); } catch { return null; }
  }
  return null;
}
export class CommandTranscript {
  constructor() { this.entries = []; this.serial = 0; this.revision = 0; this.identity = null; this.cache = null; }
  clear() { this.entries = []; this.cache = null; this.revision++; }
  setIdentity(identity) {
    if (this.identity !== identity) { this.clear(); this.identity = identity; }
  }
  show(scope, afterSeq, command, lines) {
    const id = `local-command-${++this.serial}`;
    this.entries.push({ id, scope, afterSeq, lines: [`› ${command} · 仅本机`, ...lines, ''] });
    // Bound local UI output, never truncate the server's message history here.
    if (this.entries.length > 64) this.entries.shift();
    this.revision++; this.cache = null;
    return id + ':0';
  }
  compose(chat, scope) {
    if (this.cache?.chat === chat && this.cache.scope === scope && this.cache.revision === this.revision) return this.cache;
    const body = [], keys = [], styles = [];
    const entries = this.entries.filter((entry) => entry.scope === scope);
    const groups = chat.groups?.length ? chat.groups : [{ seq: 0, body: chat.body, keys: chat.keys, styles: chat.styles }];
    let index = 0;
    const commandRows = (entry) => {
      entry.lines.forEach((line, i) => {
        body.push(line); keys.push(`${entry.id}:${i}`);
        styles.push({ role: i === 0 ? 'command' : i === 1 ? 'title' : 'ui' });
      });
    };
    for (const group of groups) {
      while (index < entries.length && entries[index].afterSeq < group.seq) commandRows(entries[index++]);
      body.push(...group.body); keys.push(...group.keys); styles.push(...group.styles);
    }
    while (index < entries.length) commandRows(entries[index++]);
    this.cache = { chat, scope, revision: this.revision, body, keys, styles };
    return this.cache;
  }
}
