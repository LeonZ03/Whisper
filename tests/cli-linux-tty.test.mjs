import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import headless from '@xterm/headless';
import { createWhisperServer } from '../server/app.mjs';
import { WhisperClient } from '../cli/client.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Linux installed CLI: real PTY, menu, masked login, Chinese chat, devices, drafts and logout', { skip: process.platform !== 'linux' || !process.env.WHISPER_TEST_LAUNCHER, timeout: 90000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-linux-tty-'));
  const app = await createWhisperServer({ port: 0, dataDir: join(dir, 'server') });
  const peer = new WhisperClient({ server: app.localUrl }), enrolling = new WhisperClient({ server: app.localUrl });
  const terminal = new headless.Terminal({ cols: 110, rows: 34, allowProposedApi: true });
  const password = 'LinuxTest9!', username = 'linux_alice', peerName = 'linux_bobby';
  let child, raw = '', exited = false, exitCode;
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
  async function waitFor(predicate, label) {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await predicate()) return; await sleep(75); }
    throw Error('Linux PTY timeout: ' + label + '\n' + screen().replaceAll(password, '[redacted]'));
  }
  const visible = text => waitFor(() => screen().includes(text), text);
  const write = text => child.stdin.write(JSON.stringify({ write: text }) + '\n');
  const enter = text => write(text + '\r');
  try {
    for (const [client, name] of [[peer, peerName], [enrolling, username]]) {
      await client.authenticate({ username: name, password, register: true });
      app.db.prepare("UPDATE users SET status='active' WHERE username=?").run(name);
    }
    await peer.authenticate({ username: peerName, password });
    child = spawn('python3', ['tests/linux-pty.py', process.env.WHISPER_TEST_LAUNCHER, '--server', app.localUrl, '--color'], {
      env: { ...process.env, TERM: 'xterm-256color', PATH: '/usr/bin:/bin', WHISPER_CLI_DATA_DIR: join(dir, 'client'), DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(dir, 'no-session-bus') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout }), decoder = new StringDecoder('utf8');
    lines.on('line', line => { const value = JSON.parse(line); if (value.data) { const text = decoder.write(Buffer.from(value.data, 'base64')); raw += text; terminal.write(text); } });
    child.stderr.resume(); child.on('close', code => { exited = true; exitCode = code; });
    await visible('服务已连接。输入 /login 或 /register。');
    write('/'); await visible('❯ /login'); enter('');
    await visible('用户名 ›'); enter(username); await visible('密码 ›');
    write(password); await sleep(200); assert.equal(raw.includes(password), false); enter('');
    await visible('已登录。用 /chat');
    assert.match(screen(), /关闭 CLI 后需要重新登录/);
    enter('/chat ' + peerName); await visible('→ @' + peerName);
    enter('来自 Linux 的中文消息'); await visible('来自 Linux 的中文消息');
    await peer.chat(username);
    await waitFor(async () => { await peer.sync(); return peer.viewMessages().some(message => message.text === '来自 Linux 的中文消息'); }, 'peer receives Linux message');
    write('Linux 连续第一段\rLinux 连续第二段\rLinux 第三段草稿');
    await waitFor(async () => { await peer.sync(); return peer.viewMessages().filter(m => m.text.startsWith('Linux 连续')).length === 2; }, 'Linux queued consecutive sends');
    assert.deepEqual(peer.viewMessages().filter(m => m.text.startsWith('Linux 连续')).map(m => m.text), ['Linux 连续第一段','Linux 连续第二段']);
    await visible('Linux 第三段草稿'); write('\x15'); await sleep(150);
    write('保留的草稿'); await peer.send('Windows 与 Linux 使用同一协议'); await visible('Windows 与 Linux 使用同一协议');
    assert.ok(screen().includes('保留的草稿')); enter('');
    await waitFor(async () => { await peer.sync(); return peer.viewMessages().some(message => message.text === '保留的草稿'); }, 'draft delivered');
    const before = peer.messages.map(message => message.id);
    for (const [command, result] of [['/me', '我的信息已追加'], ['/devices', '设备记录已追加'], ['/privacy', '隐私与边界已追加']]) {
      enter(command); await visible(result);
      if (command === '/me') await visible('CLI / Linux');
      if (command === '/devices') await visible('最近连接 IP');
    }
    await peer.sync(); assert.deepEqual(peer.messages.map(message => message.id), before);
    child.stdin.write(JSON.stringify({ resize: [70, 24] }) + '\n'); terminal.resize(70, 24); await sleep(500); await visible('Whisper CLI');
    enter('/logout'); await visible('已退出账号'); enter('/quit'); await waitFor(() => exited, 'clean exit');
    assert.equal(exitCode, 0); assert.equal(raw.includes(password), false);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)').get(username).n, 0);
    assert.equal((await peer.health()).ok, true);
  } finally {
    child?.stdin.end(); if (child && !exited) child.kill(); terminal.dispose();
    await peer.logout().catch(() => {}); await app.close(); await rm(dir, { recursive: true, force: true });
  }
});
