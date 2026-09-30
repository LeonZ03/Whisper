import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const hashFile = path => sha(readFileSync(path));
const metadata = JSON.parse(readFileSync(join(root, 'cloud/node-runtime-linux.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = resolve(root, 'public/downloads');
const work = mkdtempSync(join(tmpdir(), 'whisper-cli-linux-'));
const targets = [
  { arch: 'x64', platform: 'linux-x64', manifestName: 'manifest-linux-x64.json', archive: 'whisper-cli-linux-x64.tar.gz' },
  { arch: 'arm64', platform: 'linux-arm64', manifestName: 'manifest-linux-arm64.json', archive: 'whisper-cli-linux-arm64.tar.gz' },
];
const dependencies = new Map();

function safeCopy(source, target) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in release input: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source).sort()) safeCopy(join(source, name), join(target, name));
  } else {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
}

function copyDependency(name, destination) {
  if (dependencies.has(name)) return;
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name)) throw new Error('Invalid package name.');
  const source = join(root, 'node_modules', name);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  dependencies.set(name, manifest.version);
  safeCopy(source, join(destination, 'node_modules', name));
  for (const child of Object.keys(manifest.dependencies || {})) copyDependency(child, destination);
}

function extractRuntime(runtime, target, archivePath) {
  const prefix = runtime.filename.replace(/\.tar\.gz$/, '') + '/';
  const node = execFileSync('tar', ['-xOzf', archivePath, prefix + 'bin/node'], { maxBuffer: 256 * 1024 * 1024 });
  const license = execFileSync('tar', ['-xOzf', archivePath, prefix + 'LICENSE'], { maxBuffer: 2 * 1024 * 1024 });
  if (node.length < 1_000_000 || !license.toString('utf8').includes('Permission is hereby granted')) throw new Error('Official Linux runtime archive is incomplete.');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, node, { mode: 0o755 });
  writeFileSync(join(dirname(target), 'LICENSE'), license);
}

async function getRuntime(runtime) {
  const cache = join(root, '.runtime', runtime.filename);
  try { if (hashFile(cache) === runtime.sha256) return cache; } catch {}
  const response = await fetch(runtime.url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Official Linux runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== runtime.sha256) throw new Error(`Official Linux runtime SHA-256 mismatch: ${runtime.filename}`);
  mkdirSync(dirname(cache), { recursive: true });
  writeFileSync(cache, bytes);
  return cache;
}

try {
  const commonFiles = ['application.mjs', 'client.mjs', 'index.mjs', 'terminal.mjs', 'theme.mjs', 'transcript.mjs', 'account-ui.mjs', 'login-store.mjs', 'linux-keyring.mjs', 'update.mjs'];
  for (const target of targets) {
    dependencies.clear();
    const runtime = metadata.runtimes[target.arch];
    const archivePath = await getRuntime(runtime);
    const destination = join(work, target.platform, 'Whisper-CLI');
    for (const name of commonFiles) safeCopy(join(root, 'cli', name), join(destination, 'cli', name));
    safeCopy(join(root, 'src/crypto.mjs'), join(destination, 'src/crypto.mjs'));
    safeCopy(join(root, 'src/account-client.mjs'), join(destination, 'src/account-client.mjs'));
    safeCopy(join(root, 'src/realtime-client.mjs'), join(destination, 'src/realtime-client.mjs'));
    safeCopy(join(root, 'client-distribution/remote-entry.mjs'), join(destination, 'cli/remote-entry.mjs'));
    safeCopy(join(root, 'client-distribution/whisper'), join(destination, 'whisper'));
    safeCopy(join(root, 'client-distribution/uninstall-linux.sh'), join(destination, 'uninstall-linux.sh'));
    copyDependency('libsodium-wrappers', destination);
    copyDependency('string-width', destination);
    extractRuntime(runtime, join(destination, 'runtime/node'), archivePath);

    const version = pkg.version;
    writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: 'whisper-cli-portable', private: true, type: 'module', version }, null, 2));
    writeFileSync(join(destination, 'BUILD-INFO.json'), JSON.stringify({ version, node: metadata.version, platform: target.platform, glibcMinimum: metadata.glibcMinimum, kernelMinimum: metadata.kernelMinimum, runtimeSHA256: hashFile(join(destination, 'runtime/node')), dependencies: Object.fromEntries(dependencies) }, null, 2));
    const files = {};
    function inventory(directory, relative = '') {
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name), key = relative + name;
        if (lstatSync(path).isDirectory()) inventory(path, key + '/');
        else files[key] = hashFile(path);
      }
    }
    inventory(destination);
    writeFileSync(join(destination, 'FILES-SHA256.json'), JSON.stringify(files, null, 2));
    const tarPath = join(work, target.archive);
    execFileSync('tar', ['-czf', tarPath, '-C', join(work, target.platform), 'Whisper-CLI'], { timeout: 180000 });
    const installerPath = join(root, 'client-distribution/install.sh');
    const manifest = { version, platform: target.platform, node: metadata.version, glibcMinimum: metadata.glibcMinimum, kernelMinimum: metadata.kernelMinimum, filename: target.archive, bytes: lstatSync(tarPath).size, sha256: hashFile(tarPath), installerSha256: hashFile(installerPath), fileCount: Object.keys(files).length + 1 };
    mkdirSync(output, { recursive: true });
    cpSync(installerPath, join(root, 'public/install.sh'));
    const staging = join(output, target.archive + '.tmp');
    cpSync(tarPath, staging); renameSync(staging, join(output, target.archive));
    writeFileSync(join(output, target.manifestName), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(join(output, target.archive + '.sha256'), manifest.sha256 + '  ' + target.archive + '\n');
    console.log(JSON.stringify(manifest, null, 2));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
