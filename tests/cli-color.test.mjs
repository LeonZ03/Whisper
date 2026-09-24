import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import headless from '@xterm/headless';
import stringWidth from 'string-width';
import { TerminalUI } from '../cli/terminal.mjs';
import { TerminalTheme, colorsEnabled } from '../cli/theme.mjs';
import { COMMAND_ITEMS } from '../cli/application.mjs';
function fixture(color = 'always', env = {}) {
  const input = new PassThrough(), output = new PassThrough(); let raw = '';
  input.isTTY = output.isTTY = true; input.setRawMode = () => {};
  output.columns = 100; output.rows = 30; output.hasColors = () => true;
  const terminal = new headless.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  output.on('data', (b) => { raw += b.toString(); terminal.write(b.toString()); });
  const ui = new TerminalUI({ input, output, color, env }); ui.commands = COMMAND_ITEMS; ui.start();
  const cell = (text) => {
    for (let r = 0; r < terminal.rows; r++) {
      const line = terminal.buffer.active.getLine(r), value = line?.translateToString(true) || '';
      const at = value.indexOf(text); if (at >= 0) return line.getCell(stringWidth(value.slice(0, at)));
    }
    throw new Error('Missing test text: ' + text);
  };
  return { ui, output, terminal, cell, raw: () => raw,
    flush: () => new Promise((r) => terminal.write('', r)),
    close: () => { ui.stop(); terminal.dispose(); } };
}
test('color capability, explicit overrides, NO_COLOR, and fixed palette sanitization', () => {
  const tty = { isTTY: true, hasColors: () => true };
  assert.equal(colorsEnabled(tty, {}), true);
  for (const env of [{ NO_COLOR: '' }, { NO_COLOR: '1' }, { NODE_DISABLE_COLORS: '1' }, { FORCE_COLOR: '0' }, { TERM: 'dumb' }]) assert.equal(colorsEnabled(tty, env), false);
  assert.equal(colorsEnabled(tty, { NO_COLOR: '1' }, 'always'), true);
  assert.equal(colorsEnabled(tty, { FORCE_COLOR: '1' }, 'never'), false);
  assert.equal(colorsEnabled({ isTTY: false }, {}, 'always'), false);
  const theme = new TerminalTheme(tty, { env: {}, mode: 'always' });
  assert.equal(theme.paint('unknown', 'normal'), 'normal');
  assert.equal(theme.paint('error', '\x1b]52;c;EVIL\x07\x1b[32mtext\u202e'), '\x1b[31mtext\x1b[0m');
  assert.equal(theme.body('/clear \x1b[31mpeer text', null, 0, 'chat'), '/clear peer text');
});
test('actual terminal cells: semantic colors, neutral message text, menu, masked input, reset', async () => {
  const f = fixture(); const { ui, cell, flush } = f;
  try {
    ui.set({ header: ['Whisper CLI', 'https://example.test', '@alice → @bob  ·  已连接', '请核对  ·  保留 24h'], selfName: 'alice', connected: true, securityRole: 'warning',
      bodyKind: 'chat', body: ['SELF  12:00 #1', '  plain /clear red', 'PEER  12:01 #2', '  中文 👩‍💻'],
      bodyStyles: [{ role: 'message', own: true }, null, { role: 'message', own: false }, null], notice: 'failure test', noticeRole: 'error', hint: 'Enter 发送 · Tab 补全' });
    await flush();
    assert.equal(cell('SELF').getFgColor(), 6); assert.ok(cell('SELF').isBold());
    assert.equal(cell('PEER').getFgColor(), 2); assert.ok(cell('12:00').isDim());
    assert.ok(cell('plain').isFgDefault()); assert.ok(cell('plain').isBgDefault());
    assert.equal(cell('failure').getFgColor(), 1); assert.equal(cell('已连接').getFgColor(), 2);
    ui.key('/', {}); ui.key('', { name: 'down' }); await flush();
    assert.ok(cell('❯ /register').isInverse()); assert.equal(cell('/login').getFgColor(), 6);
    ui.key('', { name: 'u', ctrl: true });
    const pending = ui.ask('密码', { secret: true }); ui.key('NoColorSecret!2026', {}); await flush();
    assert.ok(!f.raw().includes('NoColorSecret!2026')); ui.key('', { name: 'return' }); assert.equal(await pending, 'NoColorSecret!2026');
  } finally { f.close(); }
});
test('color adds no display width, does not disturb history anchors or drafts, and supports monochrome', () => {
  const a = fixture('always'), b = fixture('never'), c = fixture('auto', { NO_COLOR: '1' });
  try {
    for (const { ui } of [a, b, c]) {
      ui.set({ header: ['Whisper CLI'], historyKey: 'chat', bodyKind: 'chat', body: Array.from({ length: 60 }, (_, i) => `中文测试 ${i} 👩‍💻 é`), bodyKeys: Array.from({ length: 60 }, (_, i) => String(i)), notice: 'ready', hint: 'Ctrl+End 回底部' });
      ui.key('草稿', {}); ui.scrollBy(12);
    }
    const plain = (ui) => ui.lastLines.map(stripVTControlCharacters);
    assert.deepEqual(plain(a.ui), plain(b.ui)); assert.deepEqual(plain(b.ui), plain(c.ui));
    assert.equal(a.ui.lastCursor, b.ui.lastCursor); assert.equal(a.ui.layout.start, b.ui.layout.start);
    for (const f of [a, b, c]) {
      const first = f.ui.anchor.key;
      f.ui.set({ body: [...f.ui.state.body, 'new'], bodyKeys: [...f.ui.state.bodyKeys, 'new'], latestSeq: 100 });
      assert.equal(f.ui.anchor.key, first); assert.equal(f.ui.buffer, '草稿');
      f.ui.key('', { name: 'u', ctrl: true }); f.ui.key('/', {});
      f.ui.key('', { name: 'down' });
    }
    assert.deepEqual(plain(a.ui), plain(b.ui));
    for (const f of [b, c]) assert.equal(/\x1b\[[0-9;]*m/.test(f.raw()), false);
    assert.ok(a.raw().includes('\x1b[36m'));
  } finally { a.close(); b.close(); c.close(); }
});
