import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'whisper-portable-verify-'));
const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const archive = join(root, 'public/downloads/whisper-cli-windows-x64.zip');
const metadata = JSON.parse(readFileSync(join(root, 'public/downloads/manifest.json')));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  assert.equal(sha(archive), metadata.sha256);
  execFileSync(shell, ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:WHISPER_TEST_ZIP -DestinationPath $env:WHISPER_TEST_DEST -ErrorAction Stop'], { timeout: 60000, env: { ...process.env, WHISPER_TEST_ZIP: archive, WHISPER_TEST_DEST: work } });
  const client = join(work, 'Whisper-CLI');
  assert.deepEqual(readdirSync(client).sort(), ['BUILD-INFO.json', 'FILES-SHA256.json', 'README.txt', 'cli', 'node_modules', 'package.json', 'runtime', 'src', 'whisper.cmd', 'uninstall.ps1'].sort());
  const expected = JSON.parse(readFileSync(join(client, 'FILES-SHA256.json')));
  const actual = [];
  function walk(directory, prefix = '') {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), relative = prefix + name;
      assert.equal(lstatSync(path).isSymbolicLink(), false);
      if (lstatSync(path).isDirectory()) walk(path, relative + '/');
      else actual.push(relative);
    }
  }
  walk(client);
  assert.deepEqual(actual.sort(), [...Object.keys(expected), 'FILES-SHA256.json'].sort());
  for (const [name, value] of Object.entries(expected)) {
    assert.ok(!name.includes('..') && !name.startsWith('/'));
    assert.equal(sha(join(client, name)), value, name);
  }
  assert.deepEqual(readdirSync(join(client, 'node_modules')).sort(), ['ansi-regex', 'get-east-asian-width', 'libsodium', 'libsodium-wrappers', 'string-width', 'strip-ansi'].sort());
  const cleanEnv = { ...process.env, PATH: join(process.env.SystemRoot, 'System32'), WHISPER_TEST_CLIENT_ROOT: client };
  delete cleanEnv.NODE_PATH; delete cleanEnv.NODE_OPTIONS; delete cleanEnv.WHISPER_SERVER;
  assert.notEqual(spawnSync(join(process.env.SystemRoot, 'System32/where.exe'), ['node'], { env: cleanEnv, cwd: client }).status, 0);
  assert.match(execFileSync(join(client, 'runtime/node.exe'), ['--input-type=module', '-e', "import {ready,deriveCredentials,wipe} from './src/crypto.mjs'; await ready; const c=await deriveCredentials('Portable-Crypto-Test!2026','AAAAAAAAAAAAAAAAAAAAAA=='); if(c.authKey.length!==32) throw Error('crypto'); wipe(c.authKey);wipe(c.vaultKey);console.log('PORTABLE_CRYPTO_OK')"], { cwd: client, env: cleanEnv, encoding: 'utf8' }), /PORTABLE_CRYPTO_OK/);
  const result = spawnSync(process.execPath, ['--test', '--test-force-exit', 'tests/cli-tty.test.mjs'], { cwd: root, env: cleanEnv, stdio: 'inherit', timeout: 110000 });
  assert.equal(result.status, 0, 'Extracted client must pass real PowerShell terminal tests without Node or npm in PATH.');
  mkdirSync(join(root, 'test-results'), { recursive: true });
  writeFileSync(join(root, 'test-results/cli-portable-package.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), sha256: metadata.sha256, files: actual.length, runtimeInPATH: false, extractedOutsideProject: true, packageContainsServerData: false }, null, 2));
  console.log('PORTABLE_PACKAGE_OK: isolated extraction, all file hashes, bundled crypto, clean PATH, real terminal chat.');
} finally { rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); }
