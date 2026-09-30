import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeServer } from './client.mjs';
import { safeText } from './theme.mjs';

const MAX_MANIFEST = 64 * 1024;
const MAX_INSTALLER = 1024 * 1024;
const TIMEOUT_MS = 30_000;
const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const safeLine = value => safeText(value).replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

export function parseReleaseVersion(value) {
  if (typeof value !== 'string' || !VERSION_RE.test(value)) throw new Error('Invalid release version.');
  return value.split('.').map(Number);
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function validateLinuxReleaseLocation(versionsDir, actualRelease, currentTarget) {
  if (dirname(actualRelease) !== versionsDir || !/^[a-f0-9]{64}$/.test(actualRelease.split(sep).at(-1)) || currentTarget !== actualRelease) {
    throw new Error('Current release is outside the managed versions directory.');
  }
  return actualRelease;
}

function assertNoLinks(path) {
  const absolute = resolve(path);
  const parsed = absolute.split(sep);
  let current = absolute.startsWith(sep) ? sep : parsed.shift();
  for (const component of parsed) {
    if (!component) continue;
    current = current === sep ? current + component : join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Refusing an installation path containing a symbolic link.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

function assertRegularFile(path, label) {
  assertNoLinks(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file.`);
}

function getInstallContext(env, entryPath, platform) {
  const homeValue = env.WHISPER_CLI_HOME;
  if (!homeValue || !resolve(homeValue)) throw new Error('Cannot locate the managed Whisper CLI installation.');
  const home = assertNoLinks(homeValue);
  if (platform === 'win32') {
    const statePath = join(home, 'installed.json');
    assertRegularFile(statePath, 'Installation record');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.app !== 'WhisperCLI' || typeof state.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(state.sha256)) throw new Error('Installation record is not a managed Whisper CLI installation.');
    assertNoLinks(entryPath);
    const entry = realpathSync(entryPath);
    const releaseRoot = dirname(dirname(entry));
    const releaseHashDir = dirname(releaseRoot);
    const versionsDir = assertNoLinks(join(home, 'versions'));
    if (dirname(releaseHashDir) !== versionsDir || releaseHashDir.split(sep).at(-1) !== state.sha256 || releaseRoot.split(sep).at(-1) !== 'Whisper-CLI') throw new Error('Running client is outside the active managed release.');
    const binDir = assertNoLinks(join(home, 'bin'));
    return { home, binDir };
  }

  assertNoLinks(entryPath);
  const expectedEntry = realpathSync(entryPath);
  // Linux installs the package contents directly under versions/<sha>.
  const releaseDir = dirname(dirname(expectedEntry));
  const versionsDir = assertNoLinks(join(home, 'versions'));
  const actualRelease = realpathSync(releaseDir);
  const currentPath = join(home, 'current');
  if (!lstatSync(currentPath).isSymbolicLink()) throw new Error('Current release pointer is not a managed installation link.');
  validateLinuxReleaseLocation(versionsDir, actualRelease, realpathSync(currentPath));
  const binPath = join(home, 'bin-dir');
  assertRegularFile(binPath, 'Saved command directory');
  const binDir = readFileSync(binPath, 'utf8').trim();
  if (!binDir || !binDir.startsWith(sep)) throw new Error('Saved command directory is invalid.');
  assertNoLinks(binDir);
  return { home, binDir };
}

async function readBounded(url, limit, fetchImpl) {
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status}).`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('Update response exceeds the allowed size.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Update response has no body.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Update response exceeds the allowed size.');
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function validateManifest(value, platform, arch) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update manifest.');
  parseReleaseVersion(value.version);
  const expectedPlatform = platform === 'win32' ? 'windows-x64' : `linux-${arch}`;
  const expectedInstaller = 'installerSha256';
  const expectedArchive = platform === 'win32' ? 'whisper-cli-windows-x64.zip' : `whisper-cli-linux-${arch}.tar.gz`;
  if (value.platform !== expectedPlatform || value.filename !== expectedArchive || !Number.isSafeInteger(value.bytes) || value.bytes < 1_000_000 || value.bytes > 268_435_456 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value[expectedInstaller] !== 'string' || !/^[a-f0-9]{64}$/.test(value[expectedInstaller])) throw new Error('Invalid update manifest.');
  return value;
}

export async function runUpdate({ env = process.env, platform = process.platform, arch = process.arch, entryPath = fileURLToPath(import.meta.url), fetchImpl = fetch, spawnImpl = spawnSync, output = console.log } = {}) {
  if (!['win32', 'linux'].includes(platform) || (platform === 'win32' && arch !== 'x64') || !['x64', 'arm64'].includes(arch)) throw new Error('This installation platform is not supported for self-update.');
  const { home, binDir } = getInstallContext(env, entryPath, platform);
  const settingsPath = join(home, 'settings.json');
  assertRegularFile(settingsPath, 'Saved server settings');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const origin = normalizeServer(settings.server);
  const packagePath = join(dirname(dirname(entryPath)), 'package.json');
  assertRegularFile(packagePath, 'Installed package metadata');
  const currentVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version;
  parseReleaseVersion(currentVersion);
  const manifestName = platform === 'win32' ? 'manifest.json' : `manifest-linux-${arch}.json`;
  output(safeLine(`Checking Whisper CLI updates from ${origin}...`));
  const manifestBytes = await readBounded(`${origin}/downloads/${manifestName}`, MAX_MANIFEST, fetchImpl);
  const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')), platform, arch);
  if (compareReleaseVersions(manifest.version, currentVersion) <= 0) {
    output(safeLine(`Already up to date (v${currentVersion}).`));
    return { status: 'current', version: currentVersion };
  }

  const installerName = platform === 'win32' ? 'install.ps1' : 'install.sh';
  output(safeLine(`Update available: v${currentVersion} -> v${manifest.version}. Verifying installer...`));
  const installer = await readBounded(`${origin}/${installerName}`, MAX_INSTALLER, fetchImpl);
  const digest = createHash('sha256').update(installer).digest('hex');
  if (digest !== manifest.installerSha256) throw new Error('Installer integrity check failed; current installation is unchanged.');
  const temp = mkdtempSync(join(tmpdir(), 'whisper-update-'));
  const installerPath = join(temp, installerName);
  try {
    writeFileSync(installerPath, installer, { mode: 0o600, flag: 'wx' });
    const args = platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installerPath, '-Server', origin, '-InstallDir', home, '-NoPath']
      : [installerPath, '--server', origin, '--install-dir', home, '--bin-dir', binDir, '--no-path'];
    const command = platform === 'win32' ? (env.SystemRoot ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe') : '/bin/bash';
    output('Starting the verified Whisper CLI installer...');
    const childEnv = platform === 'win32'
      ? { ...env, PSModulePath: join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }
      : env;
    const result = spawnImpl(command, args, { stdio: 'inherit', windowsHide: true, env: childEnv });
    if (result.error) throw new Error(`Could not start the installer: ${safeLine(result.error.message)}`);
    if (result.status !== 0) throw new Error(`Whisper CLI update failed (installer exit ${result.status ?? 'unknown'}).`);
    const postVersionPath = platform === 'win32'
      ? join(home, 'installed.json')
      : join(realpathSync(join(home, 'current')), 'BUILD-INFO.json');
    assertRegularFile(postVersionPath, 'Activated installation metadata');
    const post = JSON.parse(readFileSync(postVersionPath, 'utf8'));
    const installedVersion = platform === 'win32' ? post.version : post.version;
    if (post.app && post.app !== 'WhisperCLI' || installedVersion !== manifest.version) throw new Error('Installer exited without activating the expected version.');
    output(safeLine(`Update successful! Whisper CLI v${currentVersion} -> v${manifest.version}.`));
    return { status: 'updated', version: manifest.version };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
