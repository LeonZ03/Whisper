import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { TerminalUI, safeText } from '../cli/terminal.mjs';
import { ChatApplication, COMMAND_ITEMS } from '../cli/application.mjs';
import { historyCommand } from '../cli/transcript.mjs';
import { remainingTime } from '../cli/theme.mjs';
function fixture() {
  const input = new PassThrough(), output = new PassThrough(); let written = '';
  input.isTTY = output.isTTY = true; input.setRawMode = () => {};
  output.columns = 100; output.rows = 34;
  output.on('data', (b) => { written += b.toString(); });
  const ui = new TerminalUI({ input, output, color: 'always' }); ui.commands = COMMAND_ITEMS; ui.start();
  const client = {
    server: 'http://127.0.0.1:9999', user: { id: 'alice', username: 'alice' },
    selected: { id: 'ab', peer: { id: 'bob', username: 'bob' } }, connected: true,
    messages: [], conversations: [], ttl: '24h', hasOlder: false, calls: 0,
    trust: () => ({ blocked: false, verified: true }),
    viewMessages() { this.calls++; return this.messages.filter((m) => m.expiresAt > Date.now()); },
    async sync() {}, async logout() { this.user = null; this.messages = []; },
  };
  const app = new ChatApplication(client, ui); app.render();
  return { app, client, ui, output, raw: () => written,
    screen: () => ui.lastLines.map(safeText).join('\n'),
    key: (name, extra = {}) => ui.key('', { name, ...extra }),
    type: (text) => ui.key(text, {}), close: () => { ui.stop(); app.transcript.clear(); } };
}
test('command history: previous/next, draft restoration, popup priority, no credentials or chat text', async () => {
  const f = fixture(), { app, ui, key, type } = f;
  try {
    await app.execute('/ttl 1m'); await app.execute('/help'); await app.execute('/web');
    assert.deepEqual(ui.commandHistory, ['/ttl 1m', '/help', '/web']);
    type('没有发送的草稿'); key('left'); const cursor = ui.cursor;
    key('up'); assert.equal(ui.buffer, '/web'); assert.equal(ui.menu().length, 0);
    key('up'); assert.equal(ui.buffer, '/help'); key('up'); assert.equal(ui.buffer, '/ttl 1m');
    key('up'); assert.equal(ui.buffer, '/ttl 1m');
    key('down'); key('down'); key('down'); assert.equal(ui.buffer, '没有发送的草稿'); assert.equal(ui.cursor, cursor);
    await app.execute('/login DoNotStoreThisSecret'); await app.execute('/unknown OtherSecret');
    assert.deepEqual(ui.commandHistory, ['/ttl 1m', '/help', '/web']);
    assert.equal(historyCommand('/server', 'https://person:secret@example.com'), null);
    assert.equal(historyCommand('/chat', 'bob password'), null);
    key('u', { ctrl: true }); type('/'); key('down'); assert.equal(ui.menu()[ui.menuIndex].name, '/register');
    key('u', { ctrl: true }); key('up'); assert.equal(ui.buffer, '/web'); type(' ');
    assert.equal(ui.commandHistory.at(-1), '/web');
    const answer = ui.ask('密码', { secret: true }); type('Hidden-Only-Password'); key('up');
    assert.equal(ui.buffer, 'Hidden-Only-Password'); key('return'); await answer;
    assert.ok(!f.raw().includes('Hidden-Only-Password'));
    assert.ok(!ui.commandHistory.join('\n').includes('Secret'));
    for (let i = 1; i <= 120; i++) ui.rememberCommand('/delete ' + i);
    assert.equal(ui.commandHistory.length, 100); ui.rememberCommand('/delete 120'); assert.equal(ui.commandHistory.length, 100);
    ui.set({ commandScope: 'different-account' }); assert.equal(ui.commandHistory.length, 0);
  } finally { f.close(); }
});
test('help is inline: existing chat, incoming messages, pagination, deletion and account isolation', async () => {
  const f = fixture(), { app, ui, client } = f;
  const message = (id, seq, text) => ({ id, seq, text, own: true, type: 'text', createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
  try {
    client.messages = [message('m1', 1, '第一段聊天'), message('m2', 2, '第二段聊天')]; client.hasOlder = true;
    app.render(); const key = ui.state.historyKey;
    await app.execute('/help');
    assert.equal(ui.state.historyKey, key); assert.equal(app.overlay, null);
    assert.ok(ui.state.body.includes('  第一段聊天'));
    assert.ok(ui.state.body.some((line) => line.includes('仅本机')));
    assert.equal(ui.state.canLoadOlder, true);
    assert.ok(f.screen().includes('第二段聊天'), 'recent chat remains visible above the beginning of help');
    client.messages = [...client.messages, message('m3', 3, '帮助之后的新消息')]; app.render();
    assert.ok(ui.state.body.findIndex((s) => s.includes('› /help')) < ui.state.body.indexOf('  帮助之后的新消息'));
    await app.execute('/web');
    assert.equal(app.transcript.entries.length, 2); assert.ok(ui.state.body.includes('  第一段聊天'));
    client.messages = client.messages.filter((m) => m.id !== 'm1'); app.render();
    assert.ok(!ui.state.body.join('\n').includes('第一段聊天'));
    assert.ok(!JSON.stringify(app.transcript.entries).includes('第一段聊天'));
    client.user = null; client.selected = null; client.messages = []; app.render();
    assert.equal(app.transcript.entries.length, 0); assert.equal(ui.commandHistory.length, 0);
    assert.ok(!ui.state.body.join('\n').includes('第二段聊天'));
  } finally { f.close(); }
});
test('countdown: absolute expiry, second refresh, no repeated decrypt, stable cursor and timely removal', (t) => {
  let now = 1800000000000; t.mock.method(Date, 'now', () => now);
  const f = fixture(), { app, client, ui, type, output } = f;
  try {
    const deadline = now + 60000;
    client.messages = [{ id: 'timed', seq: 1, own: true, text: '这是一条定时清理消息', type: 'text', createdAt: now, expiresAt: deadline }];
    app.render(); const calls = client.calls;
    assert.ok(f.screen().includes('[剩余 00:01:00]'));
    type('倒计时不能移动这份草稿'); const cursor = ui.lastCursor;
    const length = f.raw().length; now += 100; app.render(); assert.equal(f.raw().length, length);
    now += 900; app.render(); assert.ok(f.screen().includes('[剩余 00:00:59]'));
    assert.equal(client.calls, calls); assert.equal(ui.lastCursor, cursor);
    assert.equal(ui.buffer, '倒计时不能移动这份草稿');
    output.columns = 26; output.rows = 16; output.emit('resize');
    assert.ok(f.screen().includes('剩余')); assert.ok(ui.lastLines.every((s) => !safeText(s).includes('\u001b')));
    now = deadline; ui.render(); assert.ok(!f.screen().includes('定时清理消息'));
    app.render(); assert.ok(!ui.state.body.join('\n').includes('定时清理消息'));
    assert.equal(remainingTime(deadline, deadline + 10000), '已到期');
    assert.equal(remainingTime(now + 86400000 + 3661000, now), '剩余 1天 01:01:01');
    assert.equal(remainingTime(NaN, now), '期限未知');
  } finally { f.close(); }
});
