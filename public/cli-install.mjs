import { installCommand } from './cli-command.mjs';
const $ = (id) => document.getElementById(id);
$('connect').textContent = `whisper --server '${location.origin}'`;
try {
  const response = await fetch('/downloads/manifest.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('unavailable');
  const release = await response.json();
  $('install').textContent = installCommand(location.origin, release);
  $('status').textContent = `CLI ${release.version} · 自动下载约 ${(release.bytes / 1048576).toFixed(1)} MiB。安装到当前用户的 WhisperCLI 目录。`;
  $('copy').disabled = false;
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('install').textContent); $('copy-status').textContent = '已复制，请在自己的 PowerShell 中执行。'; }
    catch { $('copy-status').textContent = '请手动选择上面的命令并复制。'; }
  };
} catch {
  $('status').textContent = '安装资源还未准备好，请联系服务提供者。';
  $('install').textContent = '服务提供者：运行 start.cmd 会自动检查客户端构建。';
}
