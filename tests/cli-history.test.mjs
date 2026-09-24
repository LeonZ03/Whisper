import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalUI } from '../cli/terminal.mjs';
import { COMMAND_ITEMS } from '../cli/application.mjs';
import { WhisperClient } from '../cli/client.mjs';
import { createWhisperServer } from '../server/app.mjs';
import { encryptMessage } from '../src/crypto.mjs';
function terminal() {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {};
  output.columns = 100; output.rows = 30; output.resume();
  const ui = new TerminalUI({ input, output }); ui.commands = COMMAND_ITEMS; ui.start();
  return { ui, input, output, type: (s) => { for (const c of s) ui.key(c, {}); }, key: (name, extra = {}) => ui.key('', { name, ...extra }) };
}
test('slash menu: immediate prefix matching, arrows, Enter, arguments, dismissal, safe paste', async () => {
  const { ui, type, key } = terminal(), sent = []; ui.on('line', (...args) => sent.push(args));
  try {
    type('/'); assert.equal(ui.menu().length, 14); assert.ok(ui.layout.menuHeight > 0);
    key('down'); assert.equal(ui.menu()[ui.menuIndex].name, '/register');
    key('return'); assert.deepEqual(sent.pop(), ['/register', false]);
    type('/cha'); assert.deepEqual(ui.menu().map((x) => x.name), ['/chats', '/chat']);
    key('down'); key('return'); assert.equal(ui.buffer, '/chat '); assert.equal(sent.length, 0);
    type('bobby'); key('return'); assert.deepEqual(sent.pop(), ['/chat bobby', false]);
    type('/q'); assert.equal(ui.menu()[0].name, '/quit'); key('escape'); assert.equal(ui.buffer, '/q'); assert.equal(ui.menu().length, 0);
    key('escape'); type('/nosuchcommand'); assert.equal(ui.menu().length, 0); key('u', { ctrl: true });
    type('/'); for (let i = 0; i < 13; i++) key('down');
    assert.equal(ui.menu()[ui.menuIndex].name, '/quit'); assert.ok(ui.lastLines.some((s) => s.includes('❯ /quit')));
    key('u', { ctrl: true }); key('paste-start'); type('/quit'); key('paste-end');
    assert.equal(ui.menu().length, 0); key('return'); assert.deepEqual(sent.pop(), ['/quit', true]);
    const q = ui.ask('密码', { secret: true }); type('/reg'); assert.equal(ui.menu().length, 0);
    key('return'); assert.equal(await q, '/reg');
  } finally { ui.stop(); }
});
test('scroll wheel, stable history anchor, resize, new message indicator, no draft corruption', () => {
  const { ui, input, output, type, key } = terminal();
  const body = Array.from({ length: 120 }, (_, i) => 'line ' + i), keys = body.map((_, i) => 'id' + i);
  let loads = 0; ui.on('history', () => loads++);
  try {
    ui.set({ header: ['Whisper CLI'], historyKey: 'chat1', body, bodyKeys: keys, canLoadOlder: true, latestSeq: 120 });
    type('保留这份草稿'); input.write('\x1b[<64;10;5M'); assert.ok(ui.scroll > 0);
    const first = ui.layout.body[ui.layout.start].key;
    ui.set({ body: [...body, 'new line'], bodyKeys: [...keys, 'new'], latestSeq: 121 });
    assert.equal(ui.layout.body[ui.layout.start].key, first); assert.equal(ui.newBelow, true);
    assert.equal(ui.buffer, '保留这份草稿');
    input.write('\x1b[<64;'); input.write('10;5M'); assert.equal(ui.buffer, '保留这份草稿');
    key('home', { ctrl: true }); assert.equal(ui.layout.start, 0); assert.ok(loads > 0);
    const old = ui.layout.body[0].key;
    ui.set({ body: ['older a', 'older b', ...body, 'new line'], bodyKeys: ['oldA', 'oldB', ...keys, 'new'], canLoadOlder: false });
    assert.equal(ui.layout.body[ui.layout.start].key, old); key('pageup'); assert.equal(ui.layout.start, 0);
    output.columns = 48; output.rows = 18; output.emit('resize'); assert.ok(ui.layout.start >= 0);
    key('end', { ctrl: true }); assert.equal(ui.scroll, 0); assert.equal(ui.newBelow, false);
  } finally { ui.stop(); }
});
test('501 messages: history pagination and lifecycle permissions', async () => {
  // Synthetic accounts and an isolated temporary database; never the running service.
  const dir = mkdtempSync(join(tmpdir(), 'whisper-history-'));
  const app = await createWhisperServer({ dataDir: dir, port: 0 });
  const a = new WhisperClient({ server: app.localUrl });
  const b = new WhisperClient({ server: app.localUrl });
  const c = new WhisperClient({ server: app.localUrl });
  try {
    for (const [client, username] of [[a, 'alice_history'], [b, 'bobby_history'], [c, 'carol_history']]) {
      await client.authenticate({ username, password: 'History-Test-Only!2026', invite: app.inviteCode, register: true });
    }
    await a.chat('bobby_history'); await b.chat('alice_history');
    const insert = app.db.prepare('INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)');
    const make = (text, options) => {
      const m = encryptMessage(b.user, a.user, b.selected.id, text, options);
      insert.run(m.id, b.selected.id, b.user.id, m.type, m.nonce, m.ciphertext, Date.now(), m.expiresAt);
      return m;
    };
    const image = make('AA==', { type: 'image', mime: 'image/png' });
    for (let i = 0; i < 500; i++) make(`历史样本 ${String(i).padStart(3, '0')}`);
    await a.sync(); assert.equal(a.messages.length, 200); assert.equal(a.hasOlder, true);
    assert.equal(await a.loadOlder(), 200); assert.equal(await a.loadOlder(), 101);
    assert.equal(a.messages.length, 501); assert.equal(a.hasOlder, false);
    assert.match(a.viewMessages()[1].text, /历史样本 000/);
    assert.equal(app.db.prepare('SELECT consumed_at FROM messages WHERE id=?').get(image.id).consumed_at, null);
    await assert.rejects(c.request(`/api/conversations/${a.selected.id}/history?beforeSeq=9999`), (e) => e.status === 404);
    await assert.rejects(c.request(`/api/conversations/${a.selected.id}/message-state?fromSeq=1&throughSeq=9999`), (e) => e.status === 404);
    await assert.rejects(a.request(`/api/conversations/${a.selected.id}/history?beforeSeq=nan`), (e) => e.status === 400);
    await assert.rejects(a.request(`/api/conversations/${a.selected.id}/message-state?fromSeq=20&throughSeq=1`), (e) => e.status === 400);
    const oldestText = a.messages[1]; await b.remove(oldestText.id); await a.sync();
    assert.equal(a.messages.some((m) => m.id === oldestText.id), false);
    const expired = a.messages[1]; app.db.prepare('UPDATE messages SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.id);
    await a.sync(); assert.equal(a.messages.some((m) => m.id === expired.id), false);
    await a.request(`/api/messages/${image.id}/open`, 'POST'); await a.sync();
    assert.ok(a.messages.find((m) => m.id === image.id).consumedAt);
    assert.equal(a.messages.find((m) => m.id === image.id).ciphertext, null);
    const cutoff = a.messages.at(-1).seq; await b.send('清空之后保留的新消息');
    await a.clear(a.selected.id, cutoff); await a.sync();
    assert.deepEqual(a.viewMessages().map((m) => m.text), ['清空之后保留的新消息']);
  } finally {
    await Promise.all([a, b, c].map((client) => client.logout().catch(() => {})));
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
});
