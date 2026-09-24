import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { createWhisperServer } from '../server/app.mjs';
import { WhisperClient } from '../cli/client.mjs';
import { encryptMessage } from '../src/crypto.mjs';
import { exerciseInteraction } from './cli-interaction-tty.mjs';
import { terminalFrame, writeTerminalFrame } from './terminal-frame.mjs';
const clientRoot = resolve(process.env.WHISPER_TEST_CLIENT_ROOT || '.');
const portable = Boolean(process.env.WHISPER_TEST_CLIENT_ROOT);
const clientNode = portable ? join(clientRoot, 'runtime/node.exe') : process.execPath;
const clientEntry = portable ? 'cli/remote-entry.mjs' : 'cli/index.mjs';
const reportPrefix = portable ? 'cli-package' : 'cli';
const launcher = resolve(process.env.WHISPER_TEST_LAUNCHER || join(clientRoot, 'whisper.cmd')).replaceAll("'", "''");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('CLI rejects redirected input; help still works', () => {
  assert.match(execFileSync(clientNode, [clientEntry, '--help'], { encoding: 'utf8', cwd: clientRoot }), /Whisper CLI/);
  assert.throws(() => execFileSync(clientNode, [clientEntry], { encoding: 'utf8', stdio: 'pipe', cwd: clientRoot }), (error) => { assert.match(error.stderr, /真实交互终端/); return true; });
});
test('PowerShell + ConPTY: register, masked secrets, live chat, Chinese, paste, delete, resize, exit', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cli-tty-')), app = await createWhisperServer({ dataDir: join(dir, 'db'), port: 0 });
  const bob = new WhisperClient({ server: app.localUrl }), password = 'TTY-Only-Fake-Password!2026';
  const terminal = new headless.Terminal({ cols: 110, rows: 34, allowProposedApi: true }); let child, raw = '', exited = false, exitCode = null;
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
  async function waitFor(predicate, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (predicate()) return; await sleep(100); }
    throw new Error('TTY timeout: ' + label + '\n' + screen());
  }
  const visible = (text) => waitFor(() => screen().includes(text), text), enter = (text) => child.write(text + '\r');
  try {
    await bob.authenticate({ username: 'bobby_tty', password, invite: app.inviteCode, register: true });
    const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = pty.spawn(shell, ['-NoLogo', '-NoProfile', '-Command', `& '${launcher}' --server '${app.localUrl}'; [IO.File]::WriteAllText('${dir}/shell-returned.txt', [string]$LASTEXITCODE); Write-Output 'TTY_RETURNED_TO_POWERSHELL'; Start-Sleep -Milliseconds 700`], {
      cwd: clientRoot, name: 'xterm-256color', cols: 110, rows: 34, env: { ...process.env, WHISPER_CLI_DATA_DIR: join(dir, 'pins') }, useConpty: true,
    });
    child.onData((data) => { raw += data; terminal.write(data); }); child.onExit((event) => { exited = true; exitCode = event.exitCode; });
    await visible('Whisper CLI'); child.write('/'); await visible('↑↓ 选择');
    child.write('\x1b[B'); await visible('❯ /register');
    mkdirSync('test-results', { recursive: true });
    writeFileSync(`test-results/${reportPrefix}-command-menu.txt`, screen(), 'utf8');
    writeTerminalFrame(terminal, `test-results/${reportPrefix}-color-menu.json`);
    assert.ok(terminalFrame(terminal).rows.flat().some((cell) => cell.fg.mode === 'palette' && cell.fg.value === 6), 'real PowerShell emits cyan accents');
    enter(''); await visible('用户名 ›'); enter('alice_tty');
    await visible('密码 ›'); child.write(password); await sleep(300); assert.equal(raw.includes(password), false); enter('');
    await visible('再次输入密码 ›'); enter(password); await visible('邀请码 ›'); enter(app.inviteCode); await visible('已登录');
    assert.equal(raw.includes(password), false); assert.equal(raw.includes(app.inviteCode), false);
    child.write('/cha'); await visible('↑↓ 选择'); child.write('\x1b[B'); await visible('❯ /chat ');
    enter(''); await visible('› /chat'); assert.ok(!screen().includes('→ @bobby_tty'));
    enter('bobby_tty'); await visible('→ @bobby_tty'); await visible('直接输入文字即可聊天');
    enter('你好，PowerShell！'); await visible('你好，PowerShell！');
    await bob.chat('alice_tty'); assert.equal(bob.viewMessages().at(-1).text, '你好，PowerShell！');
    await exerciseInteraction({ child, enter, visible, waitFor, screen, bob, terminal, reportPrefix });
    child.write('待发送的草稿'); await visible('待发送的草稿');
    await bob.send('来自另一个终端的即时回复'); await visible('来自另一个终端的即时回复');
    assert.ok(screen().includes('待发送的草稿')); enter(''); await sleep(500); await bob.sync();
    assert.ok(bob.viewMessages().some((m) => m.text === '待发送的草稿'));
    const count = bob.viewMessages().length;
    child.write('\x1b[200~第一行\n/quit 第二行\x1b[201~'); await visible('第一行');
    await bob.sync(); assert.equal(bob.viewMessages().length, count); assert.equal(exited, false);
    enter(''); await sleep(700); await bob.sync(); assert.ok(bob.viewMessages().some((m) => m.text === '第一行\n/quit 第二行'));
    await bob.send('before-escape\x1b]52;c;SGVsbG8=\x07after-escape'); await visible('before-escapeafter-escape');
    assert.equal(raw.includes('\x1b]52;'), false);
    await bob.sync(); const reply = bob.viewMessages().find((m) => m.text === '来自另一个终端的即时回复');
    await bob.remove(reply.id); await waitFor(() => !screen().includes('来自另一个终端的即时回复'), 'delete redraw');
    child.resize(60, 20); terminal.resize(60, 20); await sleep(700); assert.ok(screen().includes('Whisper CLI'));
    child.resize(110, 34); terminal.resize(110, 34); await sleep(700);
    enter('/safety'); await visible('双方安全码'); await visible('确认请输入 yes'); enter('no'); await visible('没有更改核对状态');
    enter('/ttl 1h'); await visible('后续文字保留 1h'); mkdirSync('test-results', { recursive: true });
    await bob.send('名字和状态有了颜色，聊天正文保持清晰。'); await visible('名字和状态有了颜色');
    writeFileSync(`test-results/${reportPrefix}-terminal-screen.txt`, screen(), 'utf8'); // Synthetic test accounts only.
    writeTerminalFrame(terminal, `test-results/${reportPrefix}-color-chat.json`);
    const display = terminalFrame(terminal).rows.flat();
    assert.ok(display.some((cell) => cell.fg.mode === 'palette' && cell.fg.value === 2));
    assert.ok(display.some((cell) => cell.fg.mode === 'palette' && cell.fg.value === 6));
    // More than one API page, inserted only into this test's temporary database.
    const put = app.db.prepare('INSERT INTO messages(id,conversation_id,sender_id,type,nonce,ciphertext,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 260; i++) {
      const m = encryptMessage(bob.user, bob.selected.peer, bob.selected.id, `滚动历史 ${String(i).padStart(3, '0')}`);
      put.run(m.id, bob.selected.id, bob.user.id, m.type, m.nonce, m.ciphertext, Date.now(), m.expiresAt);
    }
    enter('/refresh'); await visible('滚动历史 259'); child.write('翻阅时保留的草稿');
    child.write('\x1b[1;5H'); await visible('已加载'); child.write('\x1b[1;5H'); await visible('你好，PowerShell！');
    await bob.send('阅读时到达的新消息'); await visible('有新消息'); assert.ok(screen().includes('你好，PowerShell！'));
    assert.ok(screen().includes('翻阅时保留的草稿'));
    writeFileSync(`test-results/${reportPrefix}-history-screen.txt`, screen(), 'utf8');
    const earliest = app.db.prepare('SELECT id FROM messages WHERE conversation_id=? ORDER BY seq LIMIT 1').get(bob.selected.id);
    await bob.remove(earliest.id); await waitFor(() => !screen().includes('你好，PowerShell！'), 'old-page deletion');
    child.write('\x1b[1;5F'); await visible('阅读时到达的新消息');
    child.write('\x1b[<64;10;5M'); await visible('阅读历史'); assert.ok(screen().includes('翻阅时保留的草稿'));
    child.write('\x1b[1;5F'); child.write('\x15'); await sleep(200);
    enter('/clear'); await visible('确认请输入 yes'); enter('no'); await visible('清空已取消');
    await bob.sync(); assert.ok(bob.messages.length > 0);
    enter('/clear'); await visible('确认请输入 yes'); enter('yes'); await visible('已清空');
    await bob.sync(); assert.equal(bob.messages.length, 0); assert.equal(screen().includes('你好，PowerShell！'), false);
    enter('/logout'); await visible('已退出账号'); enter('/quit');
    await waitFor(() => existsSync(join(dir, 'shell-returned.txt')), 'PowerShell continuation'); assert.equal(readFileSync(join(dir, 'shell-returned.txt'), 'utf8'), '0');
    assert.equal((await bob.health()).ok, true);
    writeFileSync(`test-results/${reportPrefix}-tty-verification.json`, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), shell: 'Windows PowerShell + ConPTY', serverUnaffected: true, passwordEchoed: false, inviteEchoed: false, registration: true, bidirectionalChat: true, draftPreservedOnReceive: true, chineseAndMultilinePaste: true, terminalEscapeBlocked: true, deletionRedraw: true, resize: true, normalExit: true, slashArrowSelection: true, historyOver200: true, mouseWheel: true, readerAnchor: true, oldPageDeletion: true, semanticColors: true, commandHistory: true, inlineHelp: true, liveCountdown: true }, null, 2));
  } catch (error) { console.error(error.stack, 'EXIT_CODE', exitCode, 'TAIL', JSON.stringify(raw.slice(-800))); throw error; } finally {
    await sleep(1000);
    if (child && !exited) { try { process.kill(child.pid, 0); child.kill(); } catch {} }
    terminal.dispose();
    await bob.logout().catch(() => {}); await app.close(); await sleep(200); rmSync(dir, { recursive: true, force: true });
  }
});
