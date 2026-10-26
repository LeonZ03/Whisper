import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cliInstructions, linuxInstallCommand, installCommand, windowsBootstrapCommand, linuxBootstrapCommand } from '../public/cli-command.mjs';

const release = { installerSha256: 'a'.repeat(64) };

test('Linux install command pins the script, isolates traps, and refreshes PATH in the current shell', () => {
  const command = linuxInstallCommand('https://whisper.example/', release);
  assert.match(command, /curl -q .*--max-redirs 0/);
  assert.match(command, /sha256sum --check --status/);
  assert.ok(command.indexOf('sha256sum --check') < command.indexOf('bash "$p" --server'));
  assert.match(command, /if \( set -e;/);
  assert.match(command, /trap 'rm -f -- "\$p"' EXIT/);
  assert.doesNotMatch(command, /trap - EXIT/);
  assert.match(command, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.doesNotMatch(command, /Installation successful!/);
  assert.doesNotMatch(command, /curl\s+[^\n|]*\|\s*bash/);
});

test('Linux install command safely quotes a loopback test origin and rejects unsafe origins', () => {
  assert.match(linuxInstallCommand('http://127.0.0.1:8787/', release), /http:\/\/127\.0\.0\.1:8787/);
  for (const origin of ['http://example.com/', 'https://example.com/path', 'https://user@example.com/']) {
    assert.throws(() => linuxInstallCommand(origin, release));
  }
  assert.throws(() => linuxInstallCommand('https://example.com/', {}));
});

test('existing PowerShell install command remains available unchanged', () => {
  const command = installCommand('https://whisper.example/', release);
  assert.match(command, /powershell\.exe/);
  assert.match(command, /a{64}/);
});

test('published instructions prefer the simple uninstall verb and retain the legacy alias', () => {
  const instructions = cliInstructions('https://whisper.example/', release);
  assert.match(instructions, /whisper uninstall/);
  assert.match(instructions, /whisper --uninstall/);
});

test('short bootstrap commands use same-origin HTTPS helpers and retain long hash-pinned commands', () => {
  const windows = windowsBootstrapCommand('https://whisper.leonz03.dpdns.org/');
  assert.equal(windows, "irm -MaximumRedirection 0 'https://whisper.leonz03.dpdns.org/cli/bootstrap.ps1' | iex");
  assert.doesNotMatch(windows, /-Server/);
  assert.ok(windows.length < 150, `Windows command is ${windows.length} characters`);
  const localWindows = windowsBootstrapCommand('http://127.0.0.1:8787/');
  assert.match(localWindows, /-Server/);
  const sampleWindows = windowsBootstrapCommand('https://whisper.example/');
  assert.match(sampleWindows, /irm -MaximumRedirection 0/);
  assert.match(sampleWindows, /https:\/\/whisper\.example\/cli\/bootstrap\.ps1/);
  const linux = linuxBootstrapCommand('https://whisper.example/');
  assert.match(linux, /\/cli\/bootstrap\.sh/);
  assert.match(linux, /curl -q -fsSL.*--max-redirs 0/);
  assert.match(linux, /^\( p=\$\(mktemp\) && trap 'rm -f -- "\$p"' EXIT/);
  assert.match(linux, /-o "\$p"/);
  assert.ok(linux.indexOf('-o "$p"') < linux.indexOf('bash "$p"'));
  assert.doesNotMatch(linux, /<\(/);
  const formalLinux = linuxBootstrapCommand('https://whisper.leonz03.dpdns.org/');
  assert.match(formalLinux, /curl -q -fsSL/);
  assert.doesNotMatch(formalLinux, /--server/);
  assert.ok(formalLinux.length < 210, `Linux command is ${formalLinux.length} characters`);
  assert.ok(linux.length < 260, `Linux command is ${linux.length} characters`);
  const windowsBootstrap = readFileSync('client-distribution/bootstrap.ps1', 'utf8');
  assert.match(windowsBootstrap, /AllowAutoRedirect = \$false/);
  assert.match(windowsBootstrap, /32768/);
  assert.match(windowsBootstrap, /262144/);
  assert.match(windowsBootstrap, /Installer hash mismatch/);
  const linuxBootstrap = readFileSync('client-distribution/bootstrap.sh', 'utf8');
  assert.match(linuxBootstrap, /--max-redirs 0/);
  assert.match(linuxBootstrap, /--max-filesize 32768/);
  assert.match(linuxBootstrap, /Installer hash mismatch/);
  const instructions = cliInstructions('https://whisper.example/', release, { installerSha256: 'b'.repeat(64) });
  assert.match(instructions, /短命令/);
  assert.match(instructions, /可选：长版/);
  assert.match(instructions, /a{64}/);
  assert.match(instructions, /b{64}/);
});

test('Linux HTTPS bootstrap bounds manifest and installer, verifies installer hash before execution', { skip: process.platform !== 'linux', timeout: 30000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'whisper-bootstrap-check-'));
  const goodInstaller = Buffer.from('#!/usr/bin/env bash\necho BOOTSTRAP_INSTALLER_RAN\n');
  const hash = createHash('sha256').update(goodInstaller).digest('hex');
  let installer = goodInstaller;
  let failManifest = false;
  const server = createServer((req, res) => {
    if (failManifest && req.url === '/downloads/manifest-linux-x64.json') { res.statusCode = 503; res.end('unavailable'); return; }
    if (req.url === '/downloads/manifest-linux-x64.json') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ platform: 'linux-x64', installerSha256: hash }, null, 2));
    } else if (req.url === '/install.sh') res.end(installer);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn('bash', ['client-distribution/bootstrap.sh', '--server', origin], {
      cwd: process.cwd(), env: { ...process.env, HOME: temp, TMPDIR: temp, NO_PROXY: '*', no_proxy: '*' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Linux bootstrap timed out. stdout=${stdout}\nstderr=${stderr}`)); }, 20000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  try {
    const good = await run();
    assert.equal(good.status, 0, good.stderr || good.stdout);
    assert.match(good.stdout, /BOOTSTRAP_INSTALLER_RAN/);
    assert.doesNotMatch(good.stdout, /\b\d+%/);
    installer = Buffer.from('#!/usr/bin/env bash\necho TAMPERED\n');
    const bad = await run();
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Installer hash mismatch/);
    assert.doesNotMatch(bad.stdout, /TAMPERED/);
    failManifest = true;
    const failedDownload = await run();
    assert.notEqual(failedDownload.status, 0);
    assert.doesNotMatch(failedDownload.stdout, /BOOTSTRAP_INSTALLER_RAN|TAMPERED/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(temp, { recursive: true, force: true });
  }
});

test('launcher instructions require the Linux manifest instead of reusing the Windows installer hash', () => {
  const withoutLinuxRelease = cliInstructions('https://whisper.example/', release);
  assert.match(withoutLinuxRelease, /Linux 首次安装 \/ 更新：请从安装帮助页复制/);
  assert.doesNotMatch(withoutLinuxRelease, /whisper_install\(\)/);
  const linuxRelease = { installerSha256: 'b'.repeat(64) };
  const withLinuxRelease = cliInstructions('https://whisper.example/', release, linuxRelease);
  assert.match(withLinuxRelease, /\/cli\/bootstrap\.sh/);
  assert.match(withLinuxRelease, /whisper_install\(\)/);
  assert.match(withLinuxRelease, /b{64}/);
  assert.doesNotMatch(withLinuxRelease.slice(withLinuxRelease.indexOf('whisper_install()')), /a{64}/);
});

test('generated Linux bootstrap executes in Bash without replacing caller traps or adding false success output', { skip: process.platform !== 'linux', timeout: 30000 }, () => {
  const fixture = Buffer.from('#!/bin/bash\nprintf "Upgrade successful!\\n"\n').toString('base64');
  const hash = createHash('sha256').update(Buffer.from(fixture, 'base64')).digest('hex');
  const good = linuxInstallCommand('http://127.0.0.1:8787/', { installerSha256: hash });
  const bad = linuxInstallCommand('http://127.0.0.1:8787/', { installerSha256: '0'.repeat(64) });
  const harness = `
set -e
test_root=$(mktemp -d /tmp/whisper-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin" "$test_root/home"
printf '%s' '${fixture}' | base64 -d > "$test_root/fixture"
cat > "$test_root/bin/curl" <<'CURL'
#!/bin/bash
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then out=$2; shift 2; else shift; fi
done
cp "$WHISPER_FIXTURE" "$out"
CURL
cat > "$test_root/bin/bash" <<'BASH'
#!/bin/bash
/bin/bash "$1"
BASH
chmod +x "$test_root/bin/curl" "$test_root/bin/bash"
export WHISPER_FIXTURE="$test_root/fixture" HOME="$test_root/home" PATH="$test_root/bin:/usr/bin:/bin"
original_path=$PATH
caller_trap="printf caller-trap-preserved; rm -rf -- '$test_root'"
trap "$caller_trap" EXIT
trap -p EXIT > "$test_root/trap-before"
${good} > "$test_root/good-output"
trap -p EXIT > "$test_root/trap-after"
cmp -s "$test_root/trap-before" "$test_root/trap-after"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo 'current PATH was not refreshed' >&2; exit 1 ;; esac
grep -Fx 'Upgrade successful!' "$test_root/good-output" >/dev/null
! grep -F 'Installation successful!' "$test_root/good-output" >/dev/null
PATH=$original_path
if ${bad} > "$test_root/bad-output" 2>&1; then echo 'bad hash unexpectedly succeeded' >&2; exit 1; fi
trap -p EXIT > "$test_root/trap-after-bad"
cmp -s "$test_root/trap-before" "$test_root/trap-after-bad"
[ "$PATH" = "$original_path" ]
! grep -F 'Upgrade successful!' "$test_root/bad-output" >/dev/null
`;
  const result = spawnSync('bash', ['-s'], { input: harness, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /caller-trap-preserved/);
});
