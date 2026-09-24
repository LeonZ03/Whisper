import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 with Node.js 24+.');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required.');
const inputs = ['cli', 'src/crypto.mjs', 'client-distribution', 'package-lock.json', 'scripts/build-cli.mjs'];
const fingerprint = createHash('sha256').update(hash(process.execPath));
function digestInput(path, label) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Linked build input');
  if (lstatSync(path).isDirectory()) { for (const n of readdirSync(path).sort()) digestInput(join(path,n), label+'/'+n); }
  else fingerprint.update(label).update('\0').update(readFileSync(path));
}
for (const input of inputs) digestInput(join(root,input),input);
const sourceFingerprint = fingerprint.digest('hex');
try {
  const old = JSON.parse(readFileSync(join(root,'public/downloads/manifest.json')));
  if (!process.argv.includes('--force') && old.filename === 'whisper-cli-windows-x64.zip' && old.sourceFingerprint === sourceFingerprint && hash(join(root,'public/downloads',old.filename)) === old.sha256 && hash(join(root,'public/install.ps1')) === old.installerSha256) {
    console.log('Whisper CLI release is current; no rebuild/download needed.'); process.exit(0);
  }
} catch {}
const shell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const signature = JSON.parse(execFileSync(shell, ['-NoProfile', '-Command', '$s=Get-AuthenticodeSignature $env:WHISPER_BUILD_NODE; @{status=[string]$s.Status;signer=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress'], { encoding: 'utf8', env: { ...process.env, WHISPER_BUILD_NODE: process.execPath } }));
if (signature.status !== 'Valid' || !signature.signer?.includes('OpenJS Foundation')) throw new Error('Node runtime signature is not valid; refusing to distribute it.');
const work = mkdtempSync(join(tmpdir(), 'whisper-portable-build-'));
const destination = join(work, 'Whisper-CLI');
const output = resolve(root, 'public/downloads');
const zipName = 'whisper-cli-windows-x64.zip';
const dependencies = new Map();
function safeCopy(source, target) {
  if (lstatSync(source).isSymbolicLink()) throw new Error('Refusing symlink in release input.');
  if (lstatSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) safeCopy(join(source, name), join(target, name));
  } else { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target); }
}
function copyDependency(name) {
  if (dependencies.has(name)) return;
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name)) throw new Error('Invalid package name.');
  const source = join(root, 'node_modules', name);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  dependencies.set(name, pkg.version); safeCopy(source, join(destination, 'node_modules', name));
  for (const child of Object.keys(pkg.dependencies || {})) copyDependency(child);
}
try {
  // Deliberate allowlist. Never copy the project, data/, server/, tests/ or devDependencies.
  for (const name of ['application.mjs', 'client.mjs', 'index.mjs', 'terminal.mjs', 'theme.mjs', 'transcript.mjs']) safeCopy(join(root, 'cli', name), join(destination, 'cli', name));
  safeCopy(join(root, 'src/crypto.mjs'), join(destination, 'src/crypto.mjs'));
  for (const name of ['whisper.cmd', 'README.txt', 'uninstall.ps1']) safeCopy(join(root, 'client-distribution', name), join(destination, name));
  safeCopy(join(root, 'client-distribution/remote-entry.mjs'), join(destination, 'cli/remote-entry.mjs'));
  copyDependency('libsodium-wrappers'); copyDependency('string-width');
  safeCopy(process.execPath, join(destination, 'runtime/node.exe'));
  let license = '';
  // Reuse only the exact runtime's already-verified license; an unchanged runtime needs no network download.
  try {
    const prior = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    const previousZIP = join(output, zipName);
    if (prior.filename !== zipName || hash(previousZIP) !== prior.sha256) throw new Error('Invalid previous release');
    const readLicense = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($env:WHISPER_PREVIOUS_ZIP); function ReadZipText($name) { $e=$z.GetEntry($name); if ($null -eq $e) { $e=$z.GetEntry($name.Replace([char]47,[char]92)) }; if (!$e -or $e.Length -gt 2097152) { throw "Invalid cached license entry" }; $r=New-Object IO.StreamReader($e.Open()); try {$r.ReadToEnd()} finally {$r.Dispose()} }; try { $b=ReadZipText "Whisper-CLI/BUILD-INFO.json" | ConvertFrom-Json; $f=ReadZipText "Whisper-CLI/FILES-SHA256.json" | ConvertFrom-Json; @{node=$b.node;runtimeSHA256=$b.runtimeSHA256;licenseHash=$f."runtime/LICENSE";license=(ReadZipText "Whisper-CLI/runtime/LICENSE")}|ConvertTo-Json -Compress } finally {$z.Dispose()}';
    const cached = JSON.parse(execFileSync(shell, ['-NoProfile', '-Command', readLicense], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, WHISPER_PREVIOUS_ZIP: previousZIP } }));
    if (cached.node !== process.version || cached.runtimeSHA256 !== hash(process.execPath) || createHash('sha256').update(cached.license).digest('hex') !== cached.licenseHash) throw new Error('Cached runtime/license mismatch');
    license = cached.license;
    console.log('Using verified license for the unchanged Node.js runtime.');
  } catch { /* New or changed runtimes still require the exact official license. */ }
  if (!license) {
    const licenseURL = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
    const response = await fetch(licenseURL, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error('Cannot obtain license for the exact Node.js version.');
    license = await response.text();
  }
  if (!license.includes('Permission is hereby granted') || license.length < 10000) throw new Error('Invalid Node license response.');
  writeFileSync(join(destination, 'runtime/LICENSE'), license);
  const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
  writeFileSync(join(destination, 'package.json'), JSON.stringify({ name: 'whisper-cli-portable', private: true, type: 'module', version }, null, 2));
  writeFileSync(join(destination, 'BUILD-INFO.json'), JSON.stringify({ version, node: process.version, platform: 'win32-x64', runtimeSHA256: hash(process.execPath), dependencies: Object.fromEntries(dependencies) }, null, 2));
  const files = {};
  function inventory(directory, relative = '') {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), key = relative + name;
      if (lstatSync(path).isDirectory()) inventory(path, key + '/');
      else files[key] = hash(path);
    }
  }
  inventory(destination);
  writeFileSync(join(destination, 'FILES-SHA256.json'), JSON.stringify(files, null, 2));
  const temporaryZIP = join(work, zipName);
  execFileSync(shell, ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:WHISPER_BUILD_DIR,$env:WHISPER_BUILD_ZIP,[IO.Compression.CompressionLevel]::Optimal,$true)'], { timeout: 120000, env: { ...process.env, WHISPER_BUILD_DIR: destination, WHISPER_BUILD_ZIP: temporaryZIP } });
  const installerSha256 = hash(join(root,'client-distribution/install.ps1'));
  const manifest = { sourceFingerprint, installerSha256, version, platform: 'windows-x64', node: process.version, filename: zipName, bytes: lstatSync(temporaryZIP).size, sha256: hash(temporaryZIP), fileCount: Object.keys(files).length + 1, builtAt: new Date().toISOString() };
  mkdirSync(output, { recursive: true });
  cpSync(join(root,'client-distribution/install.ps1'),join(root,'public/install.ps1'));
  const staging = join(output, zipName + '.tmp'); cpSync(temporaryZIP, staging);
  renameSync(staging, join(output, zipName));
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(output, zipName + '.sha256'), manifest.sha256 + '  ' + zipName + '\n');
  console.log(JSON.stringify(manifest, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
