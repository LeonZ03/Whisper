import { createInterface } from 'node:readline/promises';
import { normalizeServer } from './client.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const needsServer = process.argv.slice(2).every((arg) => ['--color', '--no-color'].includes(arg));

if (needsServer && !process.env.WHISPER_SERVER && process.env.WHISPER_CLI_HOME) {
  try {
    const config = JSON.parse(readFileSync(join(process.env.WHISPER_CLI_HOME, 'settings.json'), 'utf8'));
    process.env.WHISPER_SERVER = normalizeServer(config.server);
  } catch (error) {
    if (error.code !== 'ENOENT') { console.error('Saved server is invalid; run whisper --server HTTPS_URL.'); process.exitCode = 1; }
  }
}

// This entry runs on the visitor's machine, never on the chat host.
if (!process.exitCode && needsServer && !process.env.WHISPER_SERVER) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('请在真实交互终端（PowerShell）中运行客户端。');
    process.exitCode = 1;
  } else {
    const prompt = createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
    try {
      console.log('Whisper 远程聊天客户端 · 无需启动本机服务器');
      console.log('向服务提供者索取当前 HTTPS 网址。密码不要写在命令行里。');
      process.env.WHISPER_SERVER = normalizeServer((await prompt.question('服务地址 › ')).trim());
    } catch {
      console.error('请输入服务提供者给出的有效 HTTPS 地址，再重新启动。');
      process.exitCode = 1;
    } finally { prompt.close(); }
  }
}
if (!process.exitCode) await import('./index.mjs');
