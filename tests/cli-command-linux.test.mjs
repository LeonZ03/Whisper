import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cliInstructions, linuxInstallCommand, installCommand } from '../public/cli-command.mjs';

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

test('launcher instructions require the Linux manifest instead of reusing the Windows installer hash', () => {
  const withoutLinuxRelease = cliInstructions('https://whisper.example/', release);
  assert.match(withoutLinuxRelease, /Linux 首次安装 \/ 更新：请从安装帮助页复制/);
  assert.doesNotMatch(withoutLinuxRelease, /whisper_install\(\)/);
  const linuxRelease = { installerSha256: 'b'.repeat(64) };
  const withLinuxRelease = cliInstructions('https://whisper.example/', release, linuxRelease);
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
