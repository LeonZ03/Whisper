import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let state;
try { state = JSON.parse(readFileSync(resolve(process.env.WHISPER_DATA_DIR || resolve(root, 'data'), 'runtime.json'), 'utf8')); }
catch { console.log('没有找到正在运行的 Whisper。'); process.exit(0); }
const socket = createConnection(state.pipe);
socket.setTimeout(5000, () => { console.error('停止请求超时。请在启动窗口按 Ctrl+C。'); socket.destroy(); process.exitCode = 1; });
socket.on('connect', () => socket.write(state.stopToken + '\n'));
socket.on('data', (data) => console.log(data.toString().trim() === 'OK' ? '已发送停止请求。Whisper 将关闭本机服务与其隧道。' : data.toString()));
socket.on('error', () => { console.error('无法连接 Whisper 控制通道。没有终止任何其他进程。'); process.exitCode = 1; });
