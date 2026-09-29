import { installCommand, linuxInstallCommand } from './cli-command.mjs';
const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll('[data-platform]')];
let platform = 'windows';
let renderId = 0;
let currentCommand = '';
const setPlatform = (next) => {
  platform = next;
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.platform === platform));
  $('copy').disabled = true;
  $('copy-status').textContent = '';
  void render();
};
for (const button of buttons) button.addEventListener('click', () => setPlatform(button.dataset.platform));
$('connect').textContent = `whisper --server '${location.origin}'`;

async function render() {
  const id = ++renderId;
  currentCommand = '';
  $('copy').disabled = true;
  $('copy-status').textContent = '';
  $('install').textContent = '正在读取安装信息…';
  $('status').textContent = '正在读取安装信息…';
  const linux = platform === 'linux';
  $('platform-note').textContent = linux
    ? 'Linux x64 / ARM64 · 当前用户安装 · 不需要 sudo；需要 Bash、curl、tar 与 sha256sum。'
    : 'Windows x64 · 当前用户安装 · 不需要管理员权限。';
  $('install-note').textContent = linux
    ? '命令会将安装脚本下载到临时文件，核对 SHA-256 后才运行；客户端安装到当前用户目录，不修改系统文件。'
    : '只执行你信任的服务提供者给出的命令。命令会先核对安装脚本，再下载安装并校验客户端。';
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
    currentCommand = linux ? linuxInstallCommand(location.origin, release) : installCommand(location.origin, release);
    $('install').textContent = currentCommand;
    $('status').textContent = linux
      ? `CLI ${release.version} · 支持 Linux x64 / ARM64（glibc 2.28+）。安装器会自动识别架构并下载对应版本。`
      : `CLI ${release.version} · 自动下载约 ${(release.bytes / 1048576).toFixed(1)} MiB。安装到当前用户的 WhisperCLI 目录。`;
    $('copy').disabled = false;
  } catch {
    if (id !== renderId) return;
    currentCommand = '';
    $('status').textContent = '安装资源暂不可用，请稍后重试或联系服务提供者。';
    $('install').textContent = '安装信息暂不可用';
  }
}

$('copy').onclick = async () => {
  const id = renderId;
  const command = currentCommand;
  if (!command) return;
  $('copy').disabled = true;
  for (const button of buttons) button.disabled = true;
  try {
    await navigator.clipboard.writeText(command);
    if (id === renderId && command === currentCommand) $('copy-status').textContent = '已复制，请在自己的终端中执行。';
  } catch {
    if (id === renderId && command === currentCommand) $('copy-status').textContent = '请手动选择上面的命令并复制。';
  } finally {
    for (const button of buttons) button.disabled = false;
    if (id === renderId && command === currentCommand) $('copy').disabled = false;
  }
};
await render();
