import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const run = (command, args, env, timeout = 180_000) => new Promise((resolveRun, reject) => {
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timer = setTimeout(() => { child.kill(); reject(new Error('isolated update test child timed out')); }, timeout);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', status => { clearTimeout(timer); resolveRun({ status, stdout, stderr, output: stdout + stderr }); });
});

function olderWindowsArchive(latest) {
  const prefix = 'Whisper-CLI/';
  const files = Object.fromEntries(Object.entries(unzipSync(readFileSync(join(root, 'public/downloads', latest.filename)))).map(([name, bytes]) => [name.replaceAll('\\', '/'), bytes]));
  for (const name of ['package.json', 'BUILD-INFO.json']) {
    const info = JSON.parse(Buffer.from(files[prefix + name]).toString());
    info.version = '0.0.1'; files[prefix + name] = strToU8(JSON.stringify(info));
  }
  const inventory = JSON.parse(Buffer.from(files[prefix + 'FILES-SHA256.json']).toString());
  for (const name of Object.keys(inventory)) inventory[name] = sha(files[prefix + name]);
  files[prefix + 'FILES-SHA256.json'] = strToU8(JSON.stringify(inventory));
  return zipSync(files, { level: 1 });
}

function olderLinuxArchive(latest, work) {
  const stage = join(work, 'old-release'); mkdirSync(stage);
  execFileSync('tar', ['-xzf', resolve(root, 'public/downloads', latest.filename), '-C', stage]);
  const client = join(stage, 'Whisper-CLI');
  for (const name of ['package.json', 'BUILD-INFO.json']) {
    const path = join(client, name), info = JSON.parse(readFileSync(path, 'utf8'));
    info.version = '0.0.1'; writeFileSync(path, JSON.stringify(info, null, 2));
  }
  const inventoryPath = join(client, 'FILES-SHA256.json');
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  for (const name of Object.keys(inventory)) inventory[name] = sha(readFileSync(join(client, ...name.split('/'))));
  writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2));
  const archivePath = join(work, 'old-release.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', stage, 'Whisper-CLI']);
  return readFileSync(archivePath);
}

test('Windows installed updater upgrades by verified installer, preserves local data, and reports current version', { skip: process.platform !== 'win32', timeout: 300_000 }, async () => {
  const latest = JSON.parse(readFileSync(join(root, 'public/downloads/manifest.json')));
  const installer = readFileSync(join(root, 'client-distribution/install.ps1'));
  assert.equal(sha(installer), latest.installerSha256, 'Build the current Windows release before running this integration.');
  const work = mkdtempSync(join(tmpdir(), 'whisper-cli-update-win-'));
  const local = join(work, 'local'), home = join(local, 'WhisperCLI');
  const env = { ...process.env, LOCALAPPDATA: local, TEMP: work, TMP: work, PSModulePath: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') };
  const oldZIP = olderWindowsArchive(latest);
  const oldManifest = { ...latest, version: '0.0.1', bytes: oldZIP.length, sha256: sha(oldZIP) };
  const latestZIP = readFileSync(join(root, 'public/downloads', latest.filename));
  const state = { manifest: oldManifest, archive: oldZIP, installer: Buffer.from(installer), installerRouteFails: false };
  const server = createServer((req, res) => {
    let bytes;
    if (req.url === '/downloads/manifest.json') bytes = Buffer.from(JSON.stringify(state.manifest));
    else if (req.url === '/downloads/' + latest.filename) bytes = state.archive;
    else if (req.url === '/install.ps1') bytes = state.installerRouteFails ? Buffer.from('corrupt installer') : state.installer;
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Length', bytes.length); res.end(bytes);
  });
  await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const installerPath = join(work, 'install.ps1'); writeFileSync(installerPath, installer);
  try {
    const first = await run(join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath, '-Server', origin, '-InstallDir', home, '-NoPath'], env);
    assert.equal(first.status, 0, first.output); assert.match(first.output, /Installation successful!.*0\.0\.1/);
    const data = join(home, 'data'); mkdirSync(data, { recursive: true });
    const login = join(data, `login-${sha(origin)}.dpapi`), pins = join(data, 'cli-pins.json');
    writeFileSync(login, Buffer.from('isolated-dpapi-ciphertext-fixture')); writeFileSync(pins, '{"fixture":"public-key-pin"}');
    const preserve = () => ({ login: readFileSync(login), pins: readFileSync(pins) });
    const before = preserve();
    state.manifest = latest; state.archive = latestZIP; state.installerRouteFails = true;
    const launcher = join(home, 'bin', 'whisper.cmd');
    const shell = join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const invoke = ['-NoLogo', '-NoProfile', '-Command', `& '${launcher.replaceAll("'", "''")}' update; exit $LASTEXITCODE`];
    const failed = await run(shell, invoke, env);
    assert.notEqual(failed.status, 0); assert.match(failed.output, /Installer integrity check failed/);
    assert.equal(JSON.parse(readFileSync(join(home, 'installed.json'))).version, '0.0.1');
    assert.deepEqual(preserve(), before); state.installerRouteFails = false;
    const upgraded = await run(shell, invoke, env);
    assert.equal(upgraded.status, 0, upgraded.output); assert.match(upgraded.output, /Upgrade successful! Whisper CLI v0\.0\.1 ->/);
    assert.equal(JSON.parse(readFileSync(join(home, 'installed.json'))).version, latest.version);
    assert.deepEqual(preserve(), before);
    const current = await run(shell, invoke, env);
    assert.equal(current.status, 0, current.output); assert.match(current.output, new RegExp(`Already up to date \\(v${latest.version.replaceAll('.', '\\.')}\\)`));
    assert.deepEqual(preserve(), before);
    assert.equal(JSON.parse(readFileSync(join(home, 'installed.json'))).pathAdded, false);
  } finally { await new Promise(close => server.close(close)); rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
});

test('Linux installed updater upgrades by verified installer, preserves local data, and reports current version', { skip: process.platform !== 'linux', timeout: 300_000 }, async () => {
  const latest = JSON.parse(readFileSync(join(root, 'public/downloads/manifest-linux-x64.json')));
  const installer = readFileSync(join(root, 'client-distribution/install.sh'));
  assert.equal(sha(installer), latest.installerSha256, 'Build the current Linux release before running this integration.');
  const work = mkdtempSync(join(tmpdir(), 'whisper-cli-update-linux-'));
  const homeForUser = join(work, 'home'), install = join(work, 'managed install'), bin = join(work, 'command bin'); mkdirSync(homeForUser);
  const env = { ...process.env, HOME: homeForUser, PATH: '/usr/bin:/bin', DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(work, 'no-keyring-bus')}` };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const oldArchive = olderLinuxArchive(latest, work), latestArchive = readFileSync(join(root, 'public/downloads', latest.filename));
  const oldManifest = { ...latest, version: '0.0.1', bytes: oldArchive.length, sha256: sha(oldArchive) };
  const state = { manifest: oldManifest, archive: oldArchive, installer: Buffer.from(installer), installerRouteFails: false };
  const manifestRoute = '/downloads/manifest-linux-x64.json';
  const server = createServer((req, res) => {
    let bytes;
    if (req.url === manifestRoute) bytes = Buffer.from(JSON.stringify(state.manifest, null, 2));
    else if (req.url === '/downloads/' + latest.filename) bytes = state.archive;
    else if (req.url === '/install.sh') bytes = state.installerRouteFails ? Buffer.from('corrupt installer') : state.installer;
    if (!bytes) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Length', bytes.length); res.end(bytes);
  });
  await new Promise(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const installerPath = join(work, 'install.sh'); writeFileSync(installerPath, installer);
  try {
    const first = await run('/bin/bash', [installerPath, '--server', origin, '--install-dir', install, '--bin-dir', bin, '--no-path'], env);
    assert.equal(first.status, 0, first.output); assert.match(first.output, /Installation successful!.*0\.0\.1/);
    const data = join(install, 'data');
    const login = join(data, `login-${sha(origin)}.keyring`), pins = join(data, 'cli-pins.json');
    writeFileSync(login, Buffer.from('isolated-keyring-ciphertext-fixture')); writeFileSync(pins, '{"fixture":"public-key-pin"}');
    const preserve = () => ({ login: readFileSync(login), pins: readFileSync(pins) });
    const before = preserve(); state.manifest = latest; state.archive = latestArchive; state.installerRouteFails = true;
    const launcher = join(bin, 'whisper');
    const failed = await run(launcher, ['update'], env);
    assert.notEqual(failed.status, 0); assert.match(failed.output, /Installer integrity check failed/);
    assert.equal(JSON.parse(readFileSync(join(install, 'current', 'BUILD-INFO.json'))).version, '0.0.1');
    assert.deepEqual(preserve(), before); state.installerRouteFails = false;
    const upgraded = await run(launcher, ['update'], env);
    assert.equal(upgraded.status, 0, upgraded.output); assert.match(upgraded.output, /Upgrade successful! Whisper CLI v0\.0\.1 ->/);
    assert.equal(JSON.parse(readFileSync(join(install, 'current', 'BUILD-INFO.json'))).version, latest.version);
    assert.deepEqual(preserve(), before);
    const current = await run(launcher, ['update'], env);
    assert.equal(current.status, 0, current.output); assert.match(current.output, new RegExp(`Already up to date \\(v${latest.version.replaceAll('.', '\\.')}\\)`));
    assert.deepEqual(preserve(), before);
    assert.equal(existsSync(join(homeForUser, '.profile')), false);
  } finally { await new Promise(close => server.close(close)); rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
});
