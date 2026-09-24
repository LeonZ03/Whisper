import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WhisperClient, PinStore, normalizeServer } from '../cli/client.mjs';
import { TerminalUI, safeText, wrapText, graphemes } from '../cli/terminal.mjs';
import { createWhisperServer } from '../server/app.mjs';
import { encryptMessage } from '../src/crypto.mjs';
test('CLI URLs and terminal text safety', () => {
  assert.equal(normalizeServer('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(normalizeServer('https://example.com'), 'https://example.com');
  for (const url of ['http://192.168.1.2:8787', 'http://example.com', 'file:///tmp/a', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?x=1']) assert.throws(() => normalizeServer(url));
  assert.equal(safeText('你好\x1b]52;c;SGVsbG8=\x07\x1b[31m红色\x1b[0m\u202e!'), '你好红色!');
  assert.deepEqual(wrapText('中文测试abc', 4), ['中文', '测试', 'abc']); assert.equal(graphemes('👩‍💻é').length, 2);
});
test('CLI masked input, safe paste and terminal restoration', async () => {
  const input = new PassThrough(), output = new PassThrough(); let raw = '', mode = false;
  input.isTTY = output.isTTY = true; output.columns = 80; output.rows = 24;
  input.setRawMode = (value) => { mode = value; }; output.on('data', (chunk) => { raw += chunk; });
  const ui = new TerminalUI({ input, output }), lines = []; ui.on('line', (...line) => lines.push(line)); ui.start();
  const password = 'Fake-Secret-For-Test', question = ui.ask('密码', { secret: true });
  for (const char of password) ui.key(char, {});
  assert.equal(raw.includes(password), false); ui.key('\r', { name: 'return' }); assert.equal(await question, password);
  ui.key('', { name: 'paste-start' }); ui.key('/quit', {}); ui.key('\r', { name: 'return' }); ui.key('第二行', {}); ui.key('', { name: 'paste-end' });
  assert.equal(lines.length, 0); ui.key('\r', { name: 'return' }); assert.deepEqual(lines, [['/quit\n第二行', true]]);
  ui.stop(); assert.equal(mode, false); assert.equal(ui.buffer, ''); assert.ok(raw.includes('\x1b[?1049l'));
});
test('CLI corrupt pin store fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cli-pins-'));
  try { const path = join(dir, 'pins.json'); writeFileSync(path, 'not-json'); assert.throws(() => new PinStore(path).read(), /阻止聊天/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI actual API: E2EE, deletion, expiry, unread images, pinning and account reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cli-test-')), app = await createWhisperServer({ dataDir: join(dir, 'db'), port: 0 }), wire = [];
  const a = new WhisperClient({ server: app.localUrl, pinPath: join(dir, 'alice-pins.json'), fetchImpl: (url, init) => { wire.push(init.body || ''); return fetch(url, init); } });
  const b = new WhisperClient({ server: app.localUrl }), c = new WhisperClient({ server: app.localUrl }), again = new WhisperClient({ server: app.localUrl });
  const password = 'Isolated-CLI-Test-Password!';
  try {
    for (const [client, username] of [[a, 'alice_cli'], [b, 'bobby_cli'], [c, 'carol_cli']]) await client.authenticate({ username, password, invite: app.inviteCode, register: true });
    await a.chat('bobby_cli'); await b.chat('alice_cli'); assert.equal(await a.safety(), await b.safety());
    a.verify(a.selected.peer.publicKey); assert.equal(a.trust().verified, true);
    await again.authenticate({ username: 'alice_cli', password }); assert.equal(again.user.publicKey, a.user.publicKey);
    const text = '终端加密测试：CLI ↔ Web，不能出现于服务端。';
    await a.send(text); await b.sync(); assert.equal(b.viewMessages()[0].text, text);
    await b.send('双向通信'); await a.sync(); assert.equal(a.viewMessages()[1].text, '双向通信');
    assert.equal(wire.join('').includes(text), false); assert.equal(wire.join('').includes(password), false);
    const bytes = readFileSync(join(dir, 'db', 'whisper.sqlite'));
    assert.equal(bytes.includes(Buffer.from(text)), false); assert.equal(bytes.includes(Buffer.from(password)), false);
    await assert.rejects(c.request(`/api/conversations/${a.selected.id}/messages`), (error) => error.status === 404);
    const first = b.messages[0]; await b.remove(first.id); await a.sync(); assert.equal(a.viewMessages().some((m) => m.id === first.id), false);
    const image = encryptMessage(b.user, b.selected.peer, b.selected.id, 'AA==', { type: 'image', mime: 'image/png' });
    await b.request(`/api/conversations/${b.selected.id}/messages`, 'POST', image); await a.sync();
    assert.match(a.viewMessages().at(-1).text, /CLI 不领取/); assert.equal(app.db.prepare('SELECT consumed_at FROM messages WHERE id=?').get(image.id).consumed_at, null);
    const cutoff = Math.max(...a.messages.map((m) => m.seq)); await b.send('清空确认期间的新消息');
    await a.clear(a.selected.id, cutoff); await a.sync(); assert.deepEqual(a.viewMessages().map((m) => m.text), ['清空确认期间的新消息']);
    const last = a.messages[0]; app.db.prepare('UPDATE messages SET expires_at=? WHERE id=?').run(Date.now() - 1, last.id);
    await a.sync(); assert.equal(a.viewMessages().length, 0);
    a.messages = [{ ...last, expiresAt: Date.now() - 1 }]; assert.equal(a.viewMessages().length, 0);
    const pins = readFileSync(join(dir, 'alice-pins.json'), 'utf8'); assert.equal(pins.includes(text), false); assert.equal(pins.includes(password), false);
    app.db.prepare('UPDATE users SET public_key=? WHERE id=?').run(c.user.publicKey, b.user.id);
    await a.sync(); assert.equal(a.trust().blocked, true); assert.equal(a.viewMessages().length, 0);
    await assert.rejects(a.send('必须被阻止'), /公钥变化/);
    const secret = a.user.secretKey; await a.logout(); assert.ok(secret.every((n) => n === 0)); assert.equal(a.cookie, '');
  } finally { await Promise.all([a, b, c, again].map((x) => x.logout().catch(() => {}))); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
