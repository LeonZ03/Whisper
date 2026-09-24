import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createWhisperServer } from '../server/app.mjs';
import { installCommand } from '../public/cli-command.mjs';
const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const release = JSON.parse(readFileSync('public/downloads/manifest.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(exe, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const p = spawn(exe, args, { cwd: resolve('.'), windowsHide: true, ...options }); let out = '';
    p.stdout?.on('data', (b) => { out += b; }); p.stderr?.on('data', (b) => { out += b; });
    const timer = setTimeout(() => { p.kill(); reject(new Error('child timeout')); }, 180000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolveRun({ code, out }); });
  });
}
test('installation command rejects insecure origins and missing hashes', () => {
  assert.throws(() => installCommand('http://example.com', release));
  assert.throws(() => installCommand('https://example.com', {}));
  const command = installCommand('https://example.com', release);
  assert.ok(command.includes(release.installerSha256)); assert.ok(!command.includes('Invoke-Expression'));
  assert.ok(command.includes('Get-FileHash')); assert.ok(command.includes('-MaximumRedirection 0'));
});
test('PowerShell command install, repeat install, integrity failure, installed CLI chat, uninstall', { timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-install-test-'));
  const app = await createWhisperServer({ port: 0, dataDir: join(dir, 'db') }); let badServer;
  const env = { ...process.env, LOCALAPPDATA: join(dir, 'local'), TEMP: dir, TMP: dir };
  const home = join(env.LOCALAPPDATA, 'WhisperCLI'), bin = join(home, 'bin/whisper.cmd');
  // NoPath is the only install override: do not mutate the host's persistent user PATH.
  const command = installCommand(app.localUrl, release).replace('-File $p -Server $u;', '-File $p -Server $u -NoPath;');
  try {
    const result = await run(shell, ['-NoProfile', '-Command', command + '; whisper --version; (Get-Command whisper).Source'], { env });
    assert.equal(result.code, 0, result.out); assert.ok(existsSync(bin), result.out);
    assert.ok(result.out.includes('Whisper CLI ' + release.version)); assert.ok(result.out.includes(bin));
    const marker = JSON.parse(readFileSync(join(home, 'installed.json')));
    assert.equal(marker.pathAdded, false); assert.equal(marker.sha256, release.sha256);
    assert.equal(JSON.parse(readFileSync(join(home, 'settings.json'))).server, app.localUrl);
    const installed = join(home, 'versions', release.sha256, 'Whisper-CLI');
    const applicationURL = pathToFileURL(join(installed, 'cli/application.mjs')).href;
    const entryURL = pathToFileURL(join(installed, 'cli/remote-entry.mjs')).href;
    // Exercise color-only options against the real installed entry and saved settings.
    const probeCode = `const {ChatApplication}=await import(${JSON.stringify(applicationURL)}); ChatApplication.prototype.start=async function(){console.log('SAVED_SERVER='+this.client.server);if(this.ui.theme.enabled)throw Error('no-color ignored');}; process.argv=['node','entry','--no-color']; await import(${JSON.stringify(entryURL)});`;
    const probe = await run(join(installed, 'runtime/node.exe'), ['--input-type=module', '-e', probeCode], { env: { ...env, WHISPER_CLI_HOME: home, WHISPER_SERVER: '' } });
    assert.equal(probe.code, 0, probe.out); assert.ok(probe.out.includes('SAVED_SERVER=' + app.localUrl));
    mkdirSync(join(home, 'data'), { recursive: true }); writeFileSync(join(home, 'data/cli-pins.json'), '{}');
    const repeat = await run(shell, ['-NoProfile', '-Command', command], { env });
    assert.equal(repeat.code, 0, repeat.out); assert.equal(readFileSync(join(home, 'data/cli-pins.json'), 'utf8'), '{}');
    const clean = { ...env, PATH: join(process.env.SystemRoot, 'System32'), WHISPER_TEST_CLIENT_ROOT: join(home, 'versions', release.sha256, 'Whisper-CLI'), WHISPER_TEST_LAUNCHER: bin };
    delete clean.NODE_PATH; delete clean.NODE_OPTIONS; delete clean.WHISPER_SERVER; delete clean.NODE_TEST_CONTEXT;
    const chat = await run(process.execPath, ['--test', '--test-force-exit', 'tests/cli-tty.test.mjs'], { env: clean });
    assert.equal(chat.code, 0, chat.out); assert.match(chat.out, /PowerShell.*ConPTY/); assert.match(chat.out, /pass 2/);
    badServer = createServer((req, res) => {
      if (req.url === '/downloads/manifest.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ...release, sha256: '0'.repeat(64) })); }
      else if (req.url === '/downloads/whisper-cli-windows-x64.zip') createReadStream('public/downloads/whisper-cli-windows-x64.zip').pipe(res);
      else { res.statusCode = 404; res.end(); }
    });
    await new Promise((r) => badServer.listen(0, '127.0.0.1', r));
    const before = readFileSync(bin, 'utf8');
    const bad = await run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('public/install.ps1'), '-Server', `http://127.0.0.1:${badServer.address().port}`, '-InstallDir', home, '-NoPath']);
    assert.notEqual(bad.code, 0); assert.match(bad.out, /integrity check failed/); assert.equal(readFileSync(bin, 'utf8'), before);
    const removed = await run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(home, 'uninstall.ps1'), '-Yes'], { env });
    assert.equal(removed.code, 0, removed.out); assert.equal(existsSync(bin), false);
    assert.equal(readFileSync(join(home, 'data/cli-pins.json'), 'utf8'), '{}');
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/cli-install.json', JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), userPathMutated: false, currentSessionCommand: true, repeatedInstall: true, checksumFailureBlocked: true, installedTerminalChat: true, uninstallPreservesPins: true }, null, 2));
  } finally {
    await app.close(); if (badServer) await new Promise((r) => badServer.close(r));
    await sleep(300); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});
test('start.cmd prints CLI instructions and stop clears them, using isolated local service', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-launch-test-'));
  const env = { ...process.env, WHISPER_DATA_DIR: dir, WHISPER_PORT: '0' };
  const child = spawn(process.env.ComSpec, ['/d', '/c', 'start.cmd --local-only'], { cwd: resolve('.'), env, windowsHide: true });
  let output = ''; child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  try {
    const end = Date.now() + 45000;
    while (!existsSync(join(dir, 'cli-commands.txt')) && Date.now() < end) await sleep(200);
    const state = JSON.parse(readFileSync(join(dir, 'runtime.json')));
    const commands = readFileSync(join(dir, 'cli-commands.txt'), 'utf8');
    assert.ok(commands.includes('Get-FileHash')); assert.ok(commands.includes('whisper --server')); assert.ok(commands.includes(state.localUrl));
    await sleep(300); assert.ok(output.includes('Get-FileHash'), output);
    assert.equal((await (await fetch(state.localUrl + '/api/health')).json()).instance, state.instance);
    const stop = await run(process.execPath, ['scripts/stop.mjs'], { env }); assert.equal(stop.code, 0, stop.out);
    const until = Date.now() + 10000; while (existsSync(join(dir, 'runtime.json')) && Date.now() < until) await sleep(100);
    assert.equal(existsSync(join(dir, 'runtime.json')), false);
    assert.match(readFileSync(join(dir, 'cli-commands.txt'), 'utf8'), /stopped/);
  } finally {
    if (existsSync(join(dir, 'runtime.json'))) await run(process.execPath, ['scripts/stop.mjs'], { env });
    await sleep(500); if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  }
});

test('network-only failures retry directly: bootstrap, manifest and archive; user PATH untouched', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-install-network-'));
  const app = await createWhisperServer({ port: 0, dataDir: join(dir, 'db') });
  const env = { ...process.env, LOCALAPPDATA: join(dir, 'local'), TEMP: dir, TMP: dir };
  const home = join(env.LOCALAPPDATA, 'WhisperCLI');
  const simulate = "function Invoke-WebRequest { throw [System.Net.WebException]::new('Simulated proxy transport failure') }; ";
  try {
    const bootstrap = installCommand(app.localUrl, release).replace('-File $p -Server $u;', '-File $p -Server $u -NoPath;');
    const first = await run(shell, ['-NoProfile', '-Command', simulate + bootstrap + '; whisper --version'], { env });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /retrying direct with HTTPS verification/);
    assert.equal(JSON.parse(readFileSync(join(home, 'installed.json'))).pathAdded, false);
    const q = (s) => "'" + s.replaceAll("'", "''") + "'";
    const directInstaller = simulate + `& ${q(resolve('public/install.ps1'))} -Server ${q(app.localUrl)} -InstallDir ${q(home)} -NoPath`;
    const second = await run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', directInstaller], { env });
    assert.equal(second.code, 0, second.out);
    assert.equal((second.out.match(/Default download path failed/g) || []).length, 2);
    assert.equal(JSON.parse(readFileSync(join(home, 'installed.json'))).sha256, release.sha256);
    const script = readFileSync('public/install.ps1', 'utf8');
    assert.ok(script.includes('--noproxy')); assert.ok(!script.includes('--insecure'));
    assert.ok(!script.includes('ServerCertificateValidationCallback'));
    assert.ok(!bootstrap.includes('](https://')); assert.ok(!bootstrap.includes('$\\_'));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
});
