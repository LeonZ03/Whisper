import { emitKeypressEvents } from 'node:readline';
import { TerminalTheme, safeText, remainingTime } from './theme.mjs';
export { safeText } from './theme.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import stringWidth from 'string-width';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export const graphemes = (text) => [...segmenter.segment(text)].map((item) => item.segment);
export function wrapText(value, width) {
  const result = [];
  for (const line of safeText(value).split('\n')) {
    let current = '', used = 0;
    for (const char of graphemes(line)) {
      const size = stringWidth(char);
      if (used + size > width && current) { result.push(current); current = ''; used = 0; }
      if (size > width) continue; current += char; used += size;
    }
    result.push(current);
  }
  return result;
}
const clipped = (text, width) => wrapText(text, Math.max(1, width))[0] || '';
export class TerminalUI extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout, color = 'auto', env = process.env } = {}) {
    super(); this.input = input; this.output = output;
    this.theme = new TerminalTheme(output, { mode: color, env });
    this.buffer = ''; this.cursor = 0; this.literal = false; this.pasting = false;
    this.pending = null; this.busy = false; this.scroll = 0; this.anchor = null;
    this.commandHistory = []; this.commandIndex = null; this.commandDraft = null;
    this.lastLines = []; this.lastCursor = ''; this.layout = null; this.commands = [];
    this.menuIndex = 0; this.menuPrefix = null; this.dismissed = null; this.newBelow = false;
    this.state = { header: [], body: [], bodyKeys: [], bodyStyles: [], bodyKind: 'ui', historyKey: '', notice: '', noticeRole: 'muted', hint: '', prompt: '› ' };
    this.keyInput = new PassThrough(); this.decoder = new StringDecoder('utf8'); this.rawBuffer = '';
    this.onKey = (str, key) => this.key(str, key || {});
    this.onData = (chunk) => this.feed(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.onResize = () => { this.lastLines = []; this.render(); }; this.onEnd = () => this.emit('quit');
  }
  start() {
    if (!this.input.isTTY || !this.output.isTTY || !this.input.setRawMode) throw new Error('CLI 需要真实交互终端。请在 PowerShell / Windows Terminal 中直接运行，勿使用管道、重定向或 PowerShell ISE。');
    this.active = true; emitKeypressEvents(this.keyInput); this.wasRaw = this.input.isRaw;
    this.input.setRawMode(true); this.keyInput.on('keypress', this.onKey);
    this.input.on('data', this.onData); this.input.on('end', this.onEnd);
    this.output.on('resize', this.onResize); this.input.resume();
    this.output.write('\x1b[?1049h\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H'); this.render();
  }
  set(state) {
    if (state.commandScope !== undefined && state.commandScope !== this.state.commandScope) this.resetCommandHistory();
    if (state.historyKey !== undefined && state.historyKey !== this.state.historyKey) {
      this.scroll = state.startAtTop ? Number.MAX_SAFE_INTEGER : 0; this.anchor = null; this.newBelow = false; this.layout = null;
    } else if (this.scroll > 0 && state.latestSeq > (this.state.latestSeq || 0)) this.newBelow = true;
    Object.assign(this.state, state); this.render();
  }
  resetCommandHistory() { this.commandHistory = []; this.finishHistoryNavigation(); }
  finishHistoryNavigation() { this.commandIndex = null; this.commandDraft = null; }
  rememberCommand(text) {
    // The application supplies validated commands only, never credentials or chat text.
    if (typeof text !== 'string' || !/^\/[a-z]+(?: [^\r\n]*)?$/.test(text) || text.length > 1024) return;
    if (this.commandHistory.at(-1) !== text) this.commandHistory.push(text);
    if (this.commandHistory.length > 100) this.commandHistory.shift();
    this.finishHistoryNavigation();
  }
  browseCommands(direction) {
    if (!this.commandHistory.length || this.pending || this.busy) return;
    if (this.commandIndex === null) {
      if (direction > 0) return;
      this.commandDraft = { buffer: this.buffer, cursor: this.cursor, literal: this.literal, dismissed: this.dismissed };
      this.commandIndex = this.commandHistory.length;
    }
    this.commandIndex = Math.max(0, Math.min(this.commandHistory.length, this.commandIndex + direction));
    if (this.commandIndex === this.commandHistory.length) {
      const draft = this.commandDraft;
      this.finishHistoryNavigation(); Object.assign(this, draft); this.menuPrefix = null;
    } else {
      this.buffer = this.commandHistory[this.commandIndex]; this.cursor = graphemes(this.buffer).length;
      this.literal = false; this.menuPrefix = null;
      // Recalled commands must not open a menu that steals the next history arrow.
      this.dismissed = this.buffer;
    }
    this.render();
  }
  // Consume mouse reports before readline, including fragmented packets.
  feed(text) {
    clearTimeout(this.escapeTimer); this.rawBuffer += text;
    while (this.rawBuffer) {
      const data = this.rawBuffer;
      if (data.startsWith('\x1b[<')) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data);
        if (match) { this.rawBuffer = data.slice(match[0].length); this.mouse(Number(match[1]), match[4] === 'M'); continue; }
        if (/^\x1b\[<[\d;]*$/.test(data) && data.length < 64) break;
      }
      if (data.startsWith('\x1b[M')) {
        if (data.length < 6) break;
        this.rawBuffer = data.slice(6); this.mouse(data.charCodeAt(3) - 32, true); continue;
      }
      if (data === '\x1b' || data === '\x1b[') break;
      const next = data.indexOf('\x1b', 1), take = next < 0 ? data.length : next;
      this.rawBuffer = data.slice(take); this.keyInput.write(data.slice(0, take));
    }
    if (this.rawBuffer) this.escapeTimer = setTimeout(() => {
      const tail = this.rawBuffer; this.rawBuffer = '';
      if (!tail.startsWith('\x1b[<') && !tail.startsWith('\x1b[M')) this.keyInput.write(tail);
    }, 80);
  }
  mouse(button, pressed) {
    if (!this.active || this.pasting || !pressed || !(button & 64)) return;
    this.scrollBy(button & 1 ? -3 : 3);
  }
  menu() {
    if (this.pending || this.busy || this.literal || this.pasting || !/^\/[a-z]*$/i.test(this.buffer) || this.dismissed === this.buffer) return [];
    const prefix = this.buffer.toLowerCase();
    const matches = this.commands.filter((item) => item.name.startsWith(prefix));
    if (this.menuPrefix !== prefix) {
      this.menuPrefix = prefix; this.menuIndex = Math.max(0, matches.findIndex((item) => item.name === prefix));
    }
    this.menuIndex = Math.min(this.menuIndex, Math.max(0, matches.length - 1)); return matches;
  }
  chooseCommand(execute) {
    const item = this.menu()[this.menuIndex]; if (!item) return false;
    this.finishHistoryNavigation(); this.buffer = item.name + ' '; this.cursor = graphemes(this.buffer).length;
    this.literal = false; this.menuPrefix = null; this.dismissed = null;
    if (execute && !item.argument) { this.buffer = ''; this.cursor = 0; this.emit('line', item.name, false); }
    this.render(); return true;
  }
  scrollBy(delta) {
    const max = Math.max(0, (this.layout?.body.length || 0) - (this.layout?.bodyHeight || 1));
    this.scroll = Math.max(0, Math.min(max, this.scroll + delta)); this.anchor = null;
    if (!this.scroll) this.newBelow = false;
    this.render();
    if (delta > 0 && this.layout?.start <= 3 && this.state.canLoadOlder && !this.state.historyLoading) this.emit('history');
  }
  ask(label, { secret = false } = {}) {
    if (!this.active) return Promise.reject(new Error('终端已关闭。'));
    if (this.pending) throw new Error('已有交互输入正在等待。');
    this.finishHistoryNavigation(); this.buffer = ''; this.cursor = 0; this.literal = false; this.menuPrefix = null;
    return new Promise((resolve, reject) => { this.pending = { label, secret, resolve, reject }; this.render(); });
  }
  cancelQuestion() {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; this.buffer = ''; this.cursor = 0; this.literal = false;
    const error = new Error('操作已取消。'); error.name = 'AbortError'; pending.reject(error);
  }
  insert(value) {
    this.finishHistoryNavigation();
    const limit = this.pending?.secret ? 1024 : 16000; if (this.buffer.length + value.length > limit) return;
    const parts = graphemes(this.buffer); parts.splice(this.cursor, 0, value); this.buffer = parts.join('');
    this.cursor = graphemes(parts.slice(0, this.cursor).join('') + value).length; this.dismissed = null;
  }
  key(str, key) {
    if (!this.active) return;
    if (key.name === 'paste-start') { this.pasting = true; this.literal = true; this.render(); return; }
    if (key.name === 'paste-end') { this.pasting = false; this.render(); return; }
    if (this.pasting) {
      if (!this.busy || this.pending) {
        const value = key.name === 'return' || key.name === 'enter' ? '\n' : safeText(str || '');
        this.insert(this.pending ? value.replace(/\n/g, '') : value);
      }
      return;
    }
    if (key.ctrl && ['c', 'd'].includes(key.name)) { this.emit('quit'); return; }
    const matches = this.menu();
    if (key.name === 'escape') {
      if (this.pending) this.cancelQuestion();
      else if (matches.length) this.dismissed = this.buffer;
      else { this.buffer = ''; this.cursor = 0; this.literal = false; this.scroll = 0; this.anchor = null; this.finishHistoryNavigation(); this.emit('escape'); }
      this.render(); return;
    }
    if (['up', 'down'].includes(key.name) && matches.length) {
      this.menuIndex = (this.menuIndex + (key.name === 'up' ? -1 : 1) + matches.length) % matches.length;
      this.render(); return;
    }
    if ((key.ctrl && key.name === 'home') || key.name === 'pageup') {
      this.scrollBy(key.name === 'home' ? Number.MAX_SAFE_INTEGER : Math.max(1, (this.layout?.bodyHeight || 10) - 2)); return;
    }
    if ((key.ctrl && key.name === 'end') || key.name === 'pagedown') {
      this.scrollBy(key.name === 'end' ? -Number.MAX_SAFE_INTEGER : -Math.max(1, (this.layout?.bodyHeight || 10) - 2)); return;
    }
    if (['up', 'down'].includes(key.name) && !this.pending) { this.browseCommands(key.name === 'up' ? -1 : 1); return; }
    if (this.busy && !this.pending) return;
    if (key.name === 'tab' && !this.pending && this.chooseCommand(false)) return;
    if (['backspace', 'delete', 'return', 'enter'].includes(key.name) || (key.ctrl && ['u', 'l'].includes(key.name))) this.finishHistoryNavigation();
    const parts = graphemes(this.buffer);
    if (key.ctrl && key.name === 'j' && !this.pending) this.insert('\n');
    else if (key.name === 'return' || key.name === 'enter') {
      if ((key.shift || key.meta) && !this.pending) this.insert('\n');
      else if (!this.pending && this.chooseCommand(true)) return;
      else {
        const text = this.buffer, literal = this.literal; this.buffer = ''; this.cursor = 0; this.literal = false; this.menuPrefix = null;
        if (this.pending) { const pending = this.pending; this.pending = null; pending.resolve(text); }
        else this.emit('line', text, literal);
      }
    } else if (key.name === 'backspace') {
      if (this.cursor > 0) { parts.splice(--this.cursor, 1); this.buffer = parts.join(''); }
    } else if (key.name === 'delete') { parts.splice(this.cursor, 1); this.buffer = parts.join(''); }
    else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(parts.length, this.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) this.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) this.cursor = parts.length;
    else if (key.ctrl && ['u', 'l'].includes(key.name)) { this.buffer = ''; this.cursor = 0; this.literal = false; }
    else if (str && !key.ctrl && !key.meta && !str.startsWith('\x1b')) this.insert(safeText(str).replace(/\n/g, ''));
    this.render();
  }
  render() {
    if (!this.active) return;
    const now = Date.now();
    const width = Math.max(8, (this.output.columns || 80) - 1);
    const height = Math.max(8, this.output.rows || 24);
    const header = this.state.header.flatMap((s, i) => wrapText(s, width).map((text) => this.theme.header(text, i, this.state))).slice(0, height < 16 ? 2 : 4);
    const matches = this.menu();
    const menuHeight = matches.length ? Math.min(7, matches.length + 1, Math.max(2, height - header.length - 7)) : 0;
    const bodyHeight = Math.max(1, height - header.length - 5 - menuHeight);
    if (this.wrapped?.source !== this.state.body || this.wrapped?.keys !== this.state.bodyKeys || this.wrapped?.width !== width || this.wrapped?.styles !== this.state.bodyStyles) {
      const rows = this.state.body.flatMap((s, i) => {
        const style = this.state.bodyStyles?.[i], key = String(this.state.bodyKeys?.[i] ?? i);
        const parts = wrapText(s, width).map((text, part) => ({ text, key, part, style }));
        if (style?.countdown && Number.isFinite(style.expiresAt)) {
          const reserve = Math.min(width, stringWidth('  [剩余 7天 23:59:59]'));
          if (stringWidth(parts.at(-1).text) + reserve > width) parts.push({ text: '', key, part: parts.length, style });
          parts.at(-1).countdown = style.expiresAt;
        }
        return parts;
      });
      this.wrapped = { source: this.state.body, keys: this.state.bodyKeys, width, rows, styles: this.state.bodyStyles };
    }
    const body = this.wrapped.rows.filter((line) => !Number.isFinite(line.style?.expiresAt) || line.style.expiresAt > now);
    let start = Math.max(0, body.length - bodyHeight - this.scroll);
    if (this.scroll > 0 && this.anchor) {
      let located = body.findIndex((line) => line.key === this.anchor.key && line.part === this.anchor.part);
      if (located < 0) located = body.findIndex((line) => line.key === this.anchor.key);
      if (located >= 0) start = located;
    }
    if (this.state.focusKey) {
      const index = body.findIndex((line) => line.key === this.state.focusKey);
      if (index >= 0) start = Math.max(0, index - Math.min(6, Math.floor(bodyHeight / 4)));
      this.state.focusKey = null;
    }
    start = Math.min(start, Math.max(0, body.length - bodyHeight));
    this.scroll = Math.max(0, body.length - bodyHeight - start);
    this.anchor = this.scroll > 0 && body[start] ? { key: body[start].key, part: body[start].part } : null;
    if (!this.scroll) this.newBelow = false;
    const visible = body.slice(start, start + bodyHeight).map((line) => {
      let display = this.theme.body(line.text, line.style, line.part, this.state.bodyKind);
      if (line.countdown) {
        const remaining = line.countdown - now;
        const label = clipped('  [' + remainingTime(line.countdown, now) + ']', width - stringWidth(line.text));
        display += this.theme.paint(remaining <= 10000 ? 'error' : remaining <= 60000 ? 'warning' : 'muted', label);
      }
      return display;
    });
    while (visible.length < bodyHeight) visible.push('');
    this.layout = { body, start, bodyHeight, menuHeight };
    const prompt = clipped(this.pending ? this.pending.label + ' › ' : this.state.prompt, Math.max(4, width - 4));
    const inputWidth = Math.max(2, width - stringWidth(prompt)), allParts = graphemes(this.buffer);
    let before = allParts.slice(0, this.cursor).join(''), after = allParts.slice(this.cursor).join('');
    if (this.pending?.secret) { before = '•'.repeat(Math.min(this.cursor, 32)); after = ''; }
    else { before = safeText(before).replace(/\n/g, ' ↵ '); after = safeText(after).replace(/\n/g, ' ↵ '); }
    const beforeParts = graphemes(before);
    while (stringWidth(beforeParts.join('')) >= inputWidth) beforeParts.shift();
    before = beforeParts.join(''); const entry = clipped(before + after, inputWidth);
    const menuLines = [];
    if (menuHeight) {
      const count = menuHeight - 1, offset = Math.max(0, Math.min(this.menuIndex - count + 1, matches.length - count));
      for (let i = offset; i < Math.min(matches.length, offset + count); i++) {
        const line = clipped(`${i === this.menuIndex ? '❯' : ' '} ${matches[i].name.padEnd(10)} ${matches[i].description || ''}`, width);
        if (i === this.menuIndex) menuLines.push(this.theme.paint('selected', line + ' '.repeat(Math.max(0, width - stringWidth(line)))));
        else {
          const split = Math.min(line.length, 2 + matches[i].name.padEnd(10).length);
          menuLines.push(this.theme.paint('command', line.slice(0, split)) + this.theme.paint('muted', line.slice(split)));
        }
      }
      menuLines.push(this.theme.ui(clipped(`↑↓ 选择 · Enter 确认 · Tab 补全 · Esc 收起  ${this.menuIndex + 1}/${matches.length}`, width), 'muted'));
    }
    const notice = this.pending?.secret ? '密码/邀请码隐藏输入；不记录此处输入。Esc 取消。' : this.state.notice;
    let bar = '─'.repeat(width);
    if (body.length > bodyHeight || this.state.canLoadOlder) {
      const position = ` ${start + 1}–${Math.min(body.length, start + bodyHeight)}/${body.length} 行`;
      const marker = this.state.historyLoading ? ' · 加载历史…' : this.newBelow ? ' · 有新消息 ↓ Ctrl+End' : this.scroll ? ' · 阅读历史 · Ctrl+End 回底部' : ' · 滚轮/PgUp 向上翻';
      bar = clipped(position + marker + ' ' + '─'.repeat(width), width);
    }
    const hint = this.pending ? 'Enter 确认 · Esc 取消 · Ctrl+C 退出' : this.state.hint;
    const noticeRole = this.pending?.secret ? 'muted' : this.pending ? 'warning' : this.state.noticeRole;
    const inputLine = this.theme.paint(this.busy ? 'muted' : 'accent', prompt) + this.theme.input(entry, {
      secret: this.pending?.secret, command: !this.pending && !this.literal && /^\/[a-z]*(?:\s|$)/i.test(this.buffer),
    });
    const lines = [...header, ...visible, this.theme.paint(this.newBelow ? 'accent' : 'muted', bar),
      this.theme.paint(noticeRole, clipped(notice, width)), inputLine, ...menuLines,
      this.theme.paint('muted', '─'.repeat(width)), this.theme.ui(clipped(hint, width), 'muted')];
    while (lines.length < height) lines.push('');
    const row = header.length + bodyHeight + 3, column = Math.min(width, stringWidth(prompt) + stringWidth(before) + 1);
    const cursor = `\x1b[${row};${column}H`; let patch = '';
    // Update changed rows only; countdowns never erase the screen or move the input cursor.
    for (let i = 0; i < height; i++) if (lines[i] !== this.lastLines[i]) patch += `${this.theme.reset}\x1b[${i + 1};1H\x1b[2K${lines[i]}`;
    if (patch || cursor !== this.lastCursor) this.output.write('\x1b[?25l' + patch + cursor + '\x1b[?25h');
    this.lastLines = lines.slice(0, height); this.lastCursor = cursor;
  }
  stop() {
    if (!this.active) return; this.active = false; this.cancelQuestion(); this.resetCommandHistory(); clearTimeout(this.escapeTimer);
    this.buffer = ''; this.state.body = []; this.state.bodyKeys = []; this.state.bodyStyles = []; this.lastLines = []; this.layout = null; this.anchor = null;
    this.rawBuffer = ''; this.wrapped = null; this.keyInput.off('keypress', this.onKey); this.keyInput.destroy();
    this.input.off('data', this.onData); this.input.off('end', this.onEnd); this.output.off('resize', this.onResize);
    this.input.setRawMode(Boolean(this.wasRaw)); this.input.pause();
    this.output.write(this.theme.reset + '\x1b[?1000l\x1b[?1006l\x1b[2J\x1b[H\x1b[?2004l\x1b[?25h\x1b[?1049l');
  }
}
