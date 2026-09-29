import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
const clientVersion = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8')).version;
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
test('PowerShell + ConPTY: private account commands, DPAPI login survives quit, explicit logout prevents restore', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cli-account-tty-'));
  const dataDir = join(dir, 'client'), app = await createWhisperServer({ dataDir: join(dir, 'db'), port: 0 });
  const alice = new WhisperClient({ server: app.localUrl }), bob = new WhisperClient({ server: app.localUrl });
  const password = 'TtyKeep2026', username = 'alice_account_tty', peer = 'bobby_account_tty', windows = [];
  const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const open = () => {
    const terminal = new headless.Terminal({ cols: 110, rows: 34, allowProposedApi: true });
    const returnPath = join(dir, `account-shell-returned-${windows.length}.txt`);
    const child = pty.spawn(shell, ['-NoLogo', '-NoProfile', '-Command', `& '${launcher}' --server '${app.localUrl}' --color; [IO.File]::WriteAllText('${returnPath.replaceAll("'", "''")}', [string]$LASTEXITCODE); Write-Output 'ACCOUNT_TTY_RETURNED_TO_POWERSHELL'`], {
      cwd: clientRoot, name: 'xterm-256color', cols: 110, rows: 34,
      env: { ...process.env, WHISPER_CLI_DATA_DIR: dataDir }, useConpty: true,
    });
    const window = { child, terminal, raw: '', exited: false, exitCode: null };
    windows.push(window);
    child.onData(data => { window.raw += data; terminal.write(data); });
    child.onExit(event => { window.exited = true; window.exitCode = event.exitCode; });
    window.screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
    window.waitFor = async (predicate, label, timeout = 15000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (predicate()) return; await sleep(100); }
      throw new Error('Account TTY timeout: ' + label + '\n' + window.screen().replaceAll(password, '[redacted]'));
    };
    window.visible = text => window.waitFor(() => window.screen().includes(text), text);
    window.enter = text => child.write(text + '\r');
    window.quit = async () => {
      window.enter('/quit'); await window.waitFor(() => existsSync(returnPath), 'PowerShell continuation');
      assert.equal(readFileSync(returnPath, 'utf8'), '0'); await window.waitFor(() => window.exited, 'clean CLI exit');
      assert.equal(window.raw.includes(password), false, 'masked password must never echo');
    };
    return window;
  };
  let aliceId;
  const loginCounts = () => ({
    sessions: app.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(aliceId).n,
    history: app.db.prepare('SELECT COUNT(*) AS n FROM login_history WHERE user_id=?').get(aliceId).n,
  });
  try {
    // Enrollment and approval touch only these synthetic users in this temporary database.
    for (const [client, name] of [[alice, username], [bob, peer]]) {
      await client.authenticate({ username: name, password, register: true });
      app.db.prepare("UPDATE users SET status='active' WHERE username=? AND status='pending'").run(name);
    }
    aliceId = app.db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    await bob.authenticate({ username: peer, password }); await bob.chat(username);
    await bob.send('账号命令保留的原聊天'); await bob.sync(); const messageIds = bob.messages.map(message => message.id);

    const first = open(); await first.visible('服务已连接');
    first.enter('/login'); await first.visible('用户名 ›'); first.enter(username); await first.visible('密码 ›');
    first.child.write(password); await sleep(150); assert.equal(first.raw.includes(password), false);
    first.enter(''); await first.visible('已登录。用 /chat');
    assert.deepEqual(loginCounts(), { sessions: 1, history: 1 });
    first.enter('/chat ' + peer); await first.visible('账号命令保留的原聊天');
    for (const [command, result] of [['/me', '我的信息已追加'], ['/devices', '设备记录已追加'], ['/privacy', '隐私与边界已追加']]) {
      first.enter(command); await first.visible(result); await first.visible('› ' + command + ' · 仅本机');
      if (command === '/me') { await first.visible('本机受保护存储'); await first.visible('CLI / Windows'); }
      if (command === '/devices') { await first.visible('最近 1 条'); await first.visible('最近连接 IP'); }
      if (command === '/privacy') await first.visible('CLI 不领取或保存阅后图片');
      await bob.sync(); assert.deepEqual(bob.messages.map(message => message.id), messageIds, 'local account output must not reach the peer');
    }
    const protectedFiles = readdirSync(dataDir).filter(name => name.endsWith('.dpapi'));
    assert.equal(protectedFiles.length, 1, 'a real Windows terminal must save one protected login');
    for (const file of readdirSync(dataDir)) {
      const bytes = readFileSync(join(dataDir, file));
      for (const forbidden of [password, '"secretKey"', 'whisper_session=']) assert.equal(bytes.includes(Buffer.from(forbidden)), false, 'client files must contain no plaintext login secrets');
    }
    await first.quit(); assert.deepEqual(loginCounts(), { sessions: 1, history: 1 });

    const second = open(); await second.visible('已恢复本机受保护登录');
    assert.ok(second.screen().includes('@' + username)); assert.deepEqual(loginCounts(), { sessions: 1, history: 1 });
    second.enter('/chat ' + peer); await second.visible('账号命令保留的原聊天');
    await bob.sync(); assert.deepEqual(bob.messages.map(message => message.id), messageIds);
    second.enter('/logout'); await second.visible('已退出账号');
    assert.deepEqual(loginCounts(), { sessions: 0, history: 1 });
    assert.equal(app.db.prepare('SELECT end_reason FROM login_history WHERE user_id=?').get(aliceId).end_reason, 'logout');
    assert.equal(readdirSync(dataDir).some(name => name.endsWith('.dpapi')), false);
    await second.quit();

    const third = open(); await third.visible('服务已连接。输入 /login 或 /register。');
    assert.ok(third.screen().includes('未登录')); assert.ok(!third.screen().includes('@' + username));
    assert.deepEqual(loginCounts(), { sessions: 0, history: 1 }); await third.quit();
    assert.equal((await bob.health()).ok, true, 'quitting the CLI leaves its local server running');
  } finally {
    for (const window of windows) {
      if (!window.exited) { try { window.child.kill(); } catch {} }
      window.terminal.dispose();
    }
    await bob.logout().catch(() => {}); await alice.logout().catch(() => {}); await app.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\'), 'cleanup is restricted to the test temporary directory');
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
});
test('PowerShell + ConPTY: register, masked secrets, live chat, Chinese, paste, delete, resize, exit', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-cli-tty-')), app = await createWhisperServer({ dataDir: join(dir, 'db'), port: 0 });
  const bob = new WhisperClient({ server: app.localUrl }), password = 'TtyTest2026';
  const terminal = new headless.Terminal({ cols: 110, rows: 34, allowProposedApi: true }); let child, raw = '', exited = false, exitCode = null;
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
  async function waitFor(predicate, label, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (predicate()) return; await sleep(100); }
    throw new Error('TTY timeout: ' + label + '\n' + screen());
  }
  const visible = (text) => waitFor(() => screen().includes(text), text), enter = (text) => child.write(text + '\r');
  try {
    await bob.authenticate({ username: 'bobby_tty', password, register: true });
    app.db.prepare("UPDATE users SET status='active' WHERE username='bobby_tty' AND status='pending'").run();
    await bob.authenticate({ username: 'bobby_tty', password });
    const shell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    child = pty.spawn(shell, ['-NoLogo', '-NoProfile', '-Command', `& '${launcher}' --server '${app.localUrl}' --color; [IO.File]::WriteAllText('${dir}/shell-returned.txt', [string]$LASTEXITCODE); Write-Output 'TTY_RETURNED_TO_POWERSHELL'; Start-Sleep -Milliseconds 700`], {
      cwd: clientRoot, name: 'xterm-256color', cols: 110, rows: 34, env: { ...process.env, WHISPER_CLI_DATA_DIR: join(dir, 'pins') }, useConpty: true,
    });
    child.onData((data) => { raw += data; terminal.write(data); }); child.onExit((event) => { exited = true; exitCode = event.exitCode; });
    await visible('Whisper CLI ' + clientVersion); child.write('/'); await visible('↑↓ 选择');
    child.write('\x1b[B'); await visible('❯ /register');
    mkdirSync('test-results', { recursive: true });
    writeFileSync(`test-results/${reportPrefix}-command-menu.txt`, screen(), 'utf8');
    writeTerminalFrame(terminal, `test-results/${reportPrefix}-color-menu.json`);
    assert.ok(terminalFrame(terminal).rows.flat().some((cell) => cell.fg.mode === 'palette' && cell.fg.value === 6), 'real PowerShell emits cyan accents');
    enter(''); await visible('用户名 ›'); enter('alice_tty');
    await visible('密码 ›'); child.write(password); await sleep(300); assert.equal(raw.includes(password), false); enter('');
    await visible('再次输入密码 ›'); enter(password); await visible('申请说明'); enter(''); await visible('等待管理员审批');
    app.db.prepare("UPDATE users SET status='active' WHERE username='alice_tty' AND status='pending'").run();
    enter('/login'); await visible('用户名 ›'); enter('alice_tty'); await visible('密码 ›'); enter(password); await visible('已登录');
    assert.equal(raw.includes(password), false);
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
    writeFileSync(`test-results/${reportPrefix}-tty-verification.json`, JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), shell: 'Windows PowerShell + ConPTY', serverUnaffected: true, passwordEchoed: false, registrationApproval: true, bidirectionalChat: true, draftPreservedOnReceive: true, chineseAndMultilinePaste: true, terminalEscapeBlocked: true, deletionRedraw: true, resize: true, normalExit: true, slashArrowSelection: true, historyOver200: true, mouseWheel: true, readerAnchor: true, oldPageDeletion: true, inlineHelp: true, liveCountdown: true }, null, 2));
  } catch (error) { console.error(error.stack, 'EXIT_CODE', exitCode, 'TAIL', JSON.stringify(raw.slice(-800))); throw error; } finally {
    await sleep(1000);
    if (child && !exited) { try { process.kill(child.pid, 0); child.kill(); } catch {} }
    terminal.dispose();
    await bob.logout().catch(() => {}); await app.close(); await sleep(200); rmSync(dir, { recursive: true, force: true });
  }
});
