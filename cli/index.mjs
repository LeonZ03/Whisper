#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WhisperClient } from './client.mjs';
import { TerminalUI, safeText } from './terminal.mjs';
import { ChatApplication } from './application.mjs';
function options(args) {
  const result = { color: 'auto', server: process.env.WHISPER_SERVER || `http://127.0.0.1:${process.env.WHISPER_PORT || 8787}` };
  for (let i = 0; i < args.length; i++) {
    if (['--help', '-h'].includes(args[i])) result.help = true;
    else if (args[i] === '--version') result.version = true;
    else if (args[i] === '--no-color') result.color = 'never';
    else if (args[i] === '--color') result.color = 'always';
    else if (args[i] === '--server' && args[i + 1]) result.server = args[++i];
    else throw new Error('只支持 --server URL、--no-color、--color、--help、--version；不要把密码放进命令行。');
  }
  return result;
}
let app;
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。');
  const config = options(process.argv.slice(2));
  if (config.help) console.log('Whisper CLI · 交互式双人聊天\n\nPowerShell: .\\whisper.cmd [--server HTTPS地址]\n或: npm.cmd run cli -- [--server HTTPS地址]\n\n服务提供者运行 start.cmd；朋友安装后使用 whisper --server HTTPS地址。源码入口默认连接 http://127.0.0.1:8787。\n进入后 /login 或 /register，/chat 用户名，然后输入文字并按 Enter。\n/help 查看命令；/quit 退出。默认自动启用颜色；--no-color 或 NO_COLOR 关闭配色，--color 强制启用。只接受交互终端，不支持密码参数或重定向。');
  else if (config.version) console.log('Whisper CLI 0.3.0');
  else {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const client = new WhisperClient({ server: config.server, pinPath: resolve(process.env.WHISPER_CLI_DATA_DIR || resolve(root, 'data'), 'cli-pins.json') });
    const ui = new TerminalUI({ color: config.color }); app = new ChatApplication(client, ui);
    const stop = () => { void app.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    process.on('uncaughtException', () => { process.exitCode = 1; void app.close(); });
    process.on('unhandledRejection', () => { process.exitCode = 1; void app.close(); });
    await app.start(); console.log('Whisper CLI 已退出。网页服务未停止。');
  }
} catch (error) {
  if (app) await app.close(); console.error(safeText(error.message)); process.exitCode = 1;
}
