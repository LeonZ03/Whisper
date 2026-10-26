import { installCommand, linuxInstallCommand, windowsBootstrapCommand, linuxBootstrapCommand } from './cli-command.mjs';
const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll('[data-platform]')];
let platform = 'windows';
let renderId = 0;
let currentCommand = '';
let verifiedCommand = '';
const setPlatform = (next) => {
  platform = next;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.platform === platform));
  $('copy').disabled = true;
  $('copy-verified').disabled = true;
  $('copy-status').textContent = '';
  void render();
};
for (const button of buttons) button.addEventListener('click', () => setPlatform(button.dataset.platform));

async function render() {
  const id = ++renderId;
  currentCommand = '';
  verifiedCommand = '';
  $('copy').disabled = true;
  $('copy-verified').disabled = true;
  $('copy-status').textContent = '';
  $('install').textContent = '正在读取安装信息…';
  $('verified-install').textContent = '正在读取安装信息…';
  $('status').textContent = '正在读取安装信息…';
  const linux = platform === 'linux';
  $('platform-note').textContent = linux
    ? 'Linux x64 / ARM64 · 当前用户安装 · 不需要 sudo；需要 Bash、curl、tar 与 sha256sum。'
    : 'Windows x64 · 当前用户安装 · 不需要管理员权限。';
  $('install-note').textContent = linux
    ? '短命令经 HTTPS 下载助手；助手先核对安装脚本 SHA-256，安装器再核对客户端。安装后请打开新终端；可展开下方长命令固定脚本哈希。'
    : '短命令经 HTTPS 下载助手；助手先核对安装脚本 SHA-256，安装器再核对客户端。安装后当前 PowerShell 可直接运行 whisper；可展开下方长命令固定脚本哈希。';
  try {
    const paths = linux
      ? ['/downloads/manifest-linux-x64.json', '/downloads/manifest-linux-arm64.json']
      : ['/downloads/manifest.json'];
    const releases = await Promise.all(paths.map(async (path) => {
      const response = await fetch(path, { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      return response.json();
    }));
    if (id !== renderId) return;
    const release = releases[0];
    if (linux && (releases.some((item) => item.version !== release.version || item.installerSha256 !== release.installerSha256) ||
      !/^[a-f0-9]{64}$/.test(release.installerSha256 ?? ''))) throw new Error('inconsistent');
    currentCommand = linux ? linuxBootstrapCommand(location.origin) : windowsBootstrapCommand(location.origin);
    verifiedCommand = linux ? linuxInstallCommand(location.origin, release) : installCommand(location.origin, release);
    $('install').textContent = currentCommand;
    $('verified-install').textContent = verifiedCommand;
    $('status').textContent = linux
      ? `CLI ${release.version} · 支持 Linux x64 / ARM64（glibc 2.28+）。安装器会自动识别架构并下载对应版本。`
      : `CLI ${release.version} · 自动下载约 ${(release.bytes / 1048576).toFixed(1)} MiB。安装到当前用户的 WhisperCLI 目录。`;
    $('copy').disabled = false;
    $('copy-verified').disabled = false;
  } catch {
    if (id !== renderId) return;
    currentCommand = '';
    verifiedCommand = '';
    $('status').textContent = '安装资源暂不可用，请稍后重试或联系服务提供者。';
    $('install').textContent = '安装信息暂不可用';
    $('verified-install').textContent = '安装信息暂不可用';
    $('copy-verified').disabled = true;
  }
}

async function copyCommand(button, command, status) {
  const id = renderId;
  if (!command) return;
  button.disabled = true;
  for (const button of buttons) button.disabled = true;
  try {
    await navigator.clipboard.writeText(command);
    if (id === renderId) status.textContent = '已复制，请在自己的终端中执行。';
  } catch {
    if (id === renderId) status.textContent = '请手动选择上面的命令并复制。';
  } finally {
    for (const button of buttons) button.disabled = false;
    if (id === renderId) button.disabled = false;
  }
}
$('copy').onclick = () => copyCommand($('copy'), currentCommand, $('copy-status'));
$('copy-verified').onclick = () => copyCommand($('copy-verified'), verifiedCommand, $('copy-verified-status'));
await render();
