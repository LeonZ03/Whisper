import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import './build-android-web.mjs';
import { verifyAndroidPackage } from './verify-android-package.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || join(root, '.runtime/android-sdk');
const javaHome = process.env.JAVA_HOME;
const binary = name => javaHome ? join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name + (process.platform === 'win32' ? '.exe' : '');
const tools = join(sdk, 'build-tools/35.0.0'), androidJar = join(sdk, 'platforms/android-35/android.jar');
if (!existsSync(androidJar)) throw Error('缺少 Android SDK 35。设置 ANDROID_SDK_ROOT，或按 android/README.md 准备项目内 SDK。');
const out = join(root, '.runtime/android-build'); mkdirSync(out, { recursive: true });
const run = (cmd, args, extra = {}) => {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env: process.env, ...extra });
  if (result.status !== 0) throw Error(cmd + ' failed\n' + (result.stderr || result.stdout || result.error?.message || ''));
  if (result.stdout?.trim()) console.log(result.stdout.trim());
};
const versionParts = pkg.version.split('.').map(Number);
const revision = JSON.parse(readFileSync(join(root, 'android/release.json'))).build;
if (!Number.isInteger(revision) || revision < 1 || revision > 99) throw Error('Android build number must be 1–99.');
const versionCode = versionParts[0] * 1_000_000 + versionParts[1] * 10_000 + versionParts[2] * 100 + revision;
const manifest = readFileSync(join(root, 'android/AndroidManifest.xml'), 'utf8').replace('package="org.leonz.whisper"', `package="org.leonz.whisper" android:versionName="${pkg.version}" android:versionCode="${versionCode}"`);
writeFileSync(join(out, 'AndroidManifest.xml'), manifest);
// Exact committed W path becomes an Android vector; no machine-specific bitmap.
const logoPath = /d="([^"]+)"/.exec(readFileSync(join(root, 'public/brand-mark.svg'), 'utf8'))[1];
mkdirSync(join(out, 'res/drawable'), { recursive: true });
writeFileSync(join(out, 'res/drawable/app_icon.xml'), `<?xml version="1.0" encoding="utf-8"?><vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><path android:fillColor="#235C51" android:pathData="M0,0H108V108H0Z"/><group android:scaleX="0.071" android:scaleY="0.071" android:translateX="8.2" android:translateY="9"><path android:fillColor="#FFFFFF" android:fillType="evenOdd" android:pathData="${logoPath}"/></group></vector>`);
const aapt = join(tools, 'aapt2' + (process.platform === 'win32' ? '.exe' : ''));
run(aapt, ['compile', '--dir', join(root, 'android/res'), '-o', join(out, 'resources.zip')]);
run(aapt, ['compile', '--dir', join(out, 'res'), '-o', join(out, 'icon.zip')]);
run(aapt, ['link', '-I', androidJar, '--manifest', join(out, 'AndroidManifest.xml'), '-A', join(out, 'assets'),
  '-o', join(out, 'resources.apk'), join(out, 'resources.zip'), join(out, 'icon.zip')]);
mkdirSync(join(out, 'classes'), { recursive: true }); mkdirSync(join(out, 'dex'), { recursive: true });
const sources = readdirSync(join(root, 'android/java/org/leonz/whisper')).filter(name => name.endsWith('.java')).map(name => join(root, 'android/java/org/leonz/whisper', name));
run(binary('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', androidJar, '-d', join(out, 'classes'), ...sources]);
run(binary('jar'), ['cf', join(out, 'classes.jar'), '-C', join(out, 'classes'), '.']);
run(binary('java'), ['-cp', join(tools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', androidJar, '--output', join(out, 'dex'), join(out, 'classes.jar')]);
const entries = unzipSync(readFileSync(join(out, 'resources.apk')));
entries['classes.dex'] = readFileSync(join(out, 'dex/classes.dex'));
// Android 11+ rejects a compressed resources.arsc even if apksigner/zipalign
// report success. Preserve the resource table as STORED, then align its offset.
const archive = Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, [bytes, { level: name === 'resources.arsc' ? 0 : 6 }]]));
writeFileSync(join(out, 'unsigned.apk'), zipSync(archive));
run(join(tools, 'zipalign' + (process.platform === 'win32' ? '.exe' : '')), ['-f', '-p', '4', join(out, 'unsigned.apk'), join(out, 'aligned.apk')]);
const signingDir = join(root, 'data/android-signing'); mkdirSync(signingDir, { recursive: true });
function protectPrivate(path) {
  if (process.platform !== 'win32') { chmodSync(path, 0o600); return; }
  const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const sid = /,\s*"(S-[0-9-]+)"/.exec(identity)?.[1];
  if (!sid) throw Error('Windows user SID unavailable.');
  // A Codex sandbox account may differ from the workspace owner. Preserve the
  // owner's ability to back up/reuse their signing key outside the sandbox.
  // Use Framework ACL APIs directly: a PowerShell 7 parent can supply a module
  // path that prevents Windows PowerShell 5 from importing Get-Acl.
  const ownerQuery = '[IO.Directory]::GetAccessControl([IO.Directory]::GetCurrentDirectory()).GetOwner([Security.Principal.SecurityIdentifier]).Value';
  const ownerSid = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ownerQuery, 'utf16le').toString('base64')],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^S-[0-9-]+$/.test(ownerSid)) throw Error('Workspace owner SID unavailable.');
  execFileSync('icacls.exe', [path, '/grant:r', ...[...new Set([sid, ownerSid])].map(value => `*${value}:F`), '*S-1-5-18:F', '*S-1-5-32-544:F'], { stdio: 'ignore' });
  execFileSync('icacls.exe', [path, '/inheritance:r'], { stdio: 'ignore' });
}
const keystore = process.env.WHISPER_ANDROID_KEYSTORE || join(signingDir, 'release.keystore');
const passwordPath = join(signingDir, 'signing-password.private');
let password = process.env.WHISPER_ANDROID_KEYSTORE_PASS || (existsSync(passwordPath) ? readFileSync(passwordPath, 'utf8').trim() : null);
if (existsSync(keystore) && !password) throw Error('已有签名密钥但没有密码；禁止生成替代密钥。');
if (!password) { password = randomBytes(32).toString('base64url'); writeFileSync(passwordPath, password, { mode: 0o600 }); }
if (existsSync(passwordPath)) protectPrivate(passwordPath);
const signingEnv = { ...process.env, WHISPER_APK_KEY_PASSWORD: password };
if (!existsSync(keystore)) run(binary('keytool'), ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'whisper', '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA256withRSA', '-validity', '10000', '-dname', 'CN=Whisper Android', '-storepass:env', 'WHISPER_APK_KEY_PASSWORD', '-keypass:env', 'WHISPER_APK_KEY_PASSWORD'], { env: signingEnv });
protectPrivate(keystore);
const releaseDir = join(root, 'public/downloads'); mkdirSync(releaseDir, { recursive: true });
const apk = join(releaseDir, `whisper-android-${pkg.version}-r${revision}.apk`);
run(binary('java'), ['-jar', join(tools, 'lib/apksigner.jar'), 'sign', '--ks', keystore, '--ks-key-alias', 'whisper', '--ks-pass', 'env:WHISPER_APK_KEY_PASSWORD', '--key-pass', 'env:WHISPER_APK_KEY_PASSWORD', '--out', apk, join(out, 'aligned.apk')], { env: signingEnv });
password = ''; signingEnv.WHISPER_APK_KEY_PASSWORD = '';
run(binary('java'), ['-jar', join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk]);
run(join(tools, 'zipalign' + (process.platform === 'win32' ? '.exe' : '')), ['-c', '-p', '4', apk]);
const bytes = readFileSync(apk);
verifyAndroidPackage(bytes);
const info = { version: pkg.version, build: revision, versionCode, applicationId: 'org.leonz.whisper', minAndroid: '8.0', server: 'https://whisper.leonz03.dpdns.org', filename: apk.split(/[\\/]/).at(-1), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), resourcesStoredAndAligned: true };
writeFileSync(join(releaseDir, 'android-manifest.json'), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info));
