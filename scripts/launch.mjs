import { createWhisperServer } from '../server/app.mjs';
import { cliInstructions } from '../public/cli-command.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, appendFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Whisper requires Node.js 24 or newer.'); process.exit(1); }
const dataDir = resolve(process.env.WHISPER_DATA_DIR || resolve(root, 'data'));
let cliRelease = null;
try {
  execFileSync(process.execPath, [resolve(root, 'scripts/build-cli.mjs')], { cwd: root, stdio: 'inherit', timeout: 180000 });
  cliRelease = JSON.parse(readFileSync(resolve(root, 'public/downloads/manifest.json')));
} catch { console.error('CLI build unavailable; web chat will still start. Run npm.cmd run build:cli to diagnose.'); }
const runtimeFile = resolve(dataDir, 'runtime.json');
const noTunnel = process.argv.includes('--local-only');
let app, tunnel, stopping = false, control, publicUrl = null;
try { app = await createWhisperServer({ dataDir }); }
catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error('端口已被占用。没有停止其他程序。若 Whisper 已启动，请使用现有地址，或先双击 stop.cmd。');
    if (existsSync(runtimeFile)) { try { const state = JSON.parse(readFileSync(runtimeFile)); console.log('本机地址：' + state.localUrl); if (state.publicUrl) console.log('临时地址：' + state.publicUrl); } catch {} }
  } else console.error('启动失败：', error.message);
  process.exit(1);
}
const stopToken = randomBytes(32).toString('hex');
const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\whisper-' + createHash('sha256').update(dataDir).digest('hex').slice(0, 16) : resolve(dataDir, 'control.sock');
function cliText() {
  if (!cliRelease) return 'CLI installer unavailable. Run npm.cmd run build:cli on the host.\n';
  const note = publicUrl ? 'Share these CLI commands with your friend (no invite code included).\n' : 'LOCAL ONLY: 127.0.0.1 is not reachable from another computer.\n';
  return note + cliInstructions(publicUrl || app.localUrl, cliRelease);
}
function persist() {
  writeFileSync(runtimeFile, JSON.stringify({ pid: process.pid, tunnelPid: tunnel?.pid || null, pipe, stopToken, localUrl: app.localUrl, publicUrl, instance: app.instance }, null, 2), { mode: 0o600 });
  writeFileSync(resolve(dataDir, 'access-info.txt'), `Whisper 当前访问信息\n\n本机地址：${app.localUrl}\n临时地址：${publicUrl || (noTunnel ? '仅本机模式' : '尚未连通，请查看启动窗口')}\n邀请码：${app.inviteCode}\n\n这是同一个本机服务。不要公开分享邀请码。\n停止：双击工程根目录 stop.cmd\n安全说明：本实验版未经安全审计，无法防截图、无法保证完全匿名。\n`, 'utf8');
  appendFileSync(resolve(dataDir, 'access-info.txt'), '\n' + cliText(), 'utf8');
  writeFileSync(resolve(dataDir, 'cli-commands.txt'), cliText(), 'utf8');
  writeFileSync(resolve(dataDir, 'public-url.txt'), (publicUrl || '') + '\n');
}
async function shutdown() {
  if (stopping) return; stopping = true; console.log('\n正在停止 Whisper 与本次启动的 Cloudflare 隧道…');
  if (tunnel && !tunnel.killed) {
    if (process.platform === 'win32') { try { execFileSync('taskkill.exe', ['/PID', String(tunnel.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
    else tunnel.kill('SIGTERM');
  }
  control?.close(); await app.close();
  try { unlinkSync(runtimeFile); } catch {}
  writeFileSync(resolve(dataDir, 'public-url.txt'), '');
  writeFileSync(resolve(dataDir, 'access-info.txt'), 'Whisper 已停止。双击工程根目录 start.cmd 重新启动。\n', 'utf8');
  writeFileSync(resolve(dataDir, 'cli-commands.txt'), 'Whisper stopped. Start again for current CLI commands.\n');
  console.log('已停止。'); process.exit(0);
}
control = createServer((socket) => {
  socket.setTimeout(3000, () => socket.destroy()); let data = '';
  socket.on('data', (chunk) => {
    data += chunk.toString(); if (data.length > 256) return socket.destroy();
    if (!data.includes('\n')) return;
    const supplied = Buffer.from(data.trim()); const expected = Buffer.from(stopToken);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) { socket.end('OK\n'); setTimeout(shutdown, 50); }
    else socket.destroy();
  });
});
control.on('error', (error) => { console.error('停止控制通道创建失败：' + error.code); shutdown(); });
control.listen(pipe); persist();
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
console.log('\n============================================================');
console.log('  Whisper · 双人加密聊天实验版');
console.log('============================================================');
console.log('  本机地址：' + app.localUrl);
console.log('  邀请码：  ' + app.inviteCode);
console.log('  停止方式：双击 stop.cmd，或在本窗口按 Ctrl+C');
console.log('  地址记录：data\\access-info.txt');
console.log('  请勿发送敏感信息；阅后清理无法防截图。');
console.log('============================================================\n');
console.log('  本机 CLI：.\\whisper.cmd --server ' + app.localUrl);
if (noTunnel) { console.log('当前为仅本机模式，没有创建公网隧道。'); console.log(cliText()); }
else {
  let executable = process.env.WHISPER_CLOUDFLARED;
  if (!executable) {
    try { executable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]; } catch {}
  }
  if (!executable) { console.error('未找到 cloudflared。仅本机服务已启动；请安装 cloudflared 或设置 WHISPER_CLOUDFLARED。'); }
  else {
    const config = resolve(dataDir, 'cloudflared-quick.yml'); writeFileSync(config, '{}\n');
    const log = resolve(dataDir, 'cloudflared.log'); writeFileSync(log, '');
    // Explicit project-scoped empty config avoids changing any existing user tunnel configuration.
    const args = ['tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--metrics', '127.0.0.1:0', '--url', app.localUrl];
    console.log('正在建立 Cloudflare 临时隧道…');
    tunnel = spawn(executable, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); persist();
    let tail = '', announced = false;
    function output(chunk) {
      const text = chunk.toString(); appendFileSync(log, text); tail = (tail + text).slice(-12000);
      if (!publicUrl) {
        const match = tail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
        if (match) {
          publicUrl = match[0]; app.setPublicOrigin(publicUrl); persist();
          console.log('\n' + cliText());
          console.log('\n  临时地址：' + publicUrl + '\n  地址已分配，正在确认隧道连接。两个入口使用同一个本机服务。\n');
        }
      }
      if (!announced && /Registered tunnel connection/.test(tail)) { announced = true; console.log('  Cloudflare 隧道已连接，可以用临时地址访问。\n'); }
      if (/ERR|error/i.test(text)) process.stderr.write('[cloudflared] ' + text);
    }
    tunnel.stdout.on('data', output); tunnel.stderr.on('data', output);
    tunnel.on('error', (error) => console.error('无法启动 cloudflared：' + error.message + '。本机服务仍然可用。'));
    tunnel.on('exit', (code) => {
      if (stopping) return;
      publicUrl = null; persist(); console.error('Cloudflare 隧道已退出（' + code + '）。本机服务仍可用；详情见 data\\cloudflared.log。');
    });
    setTimeout(() => { if (!announced && !stopping) console.log('隧道尚未确认连接。请查看 data\\cloudflared.log；本机地址已可使用。'); }, 45_000).unref();
  }
}
