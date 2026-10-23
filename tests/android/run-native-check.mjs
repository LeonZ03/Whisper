import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { androidDependencies } from '../../scripts/android-dependencies.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || join(root, '.runtime/android-sdk');
const androidJar = join(sdk, 'platforms/android-35/android.jar');
const dependencies = await androidDependencies();
const out = mkdtempSync(join(tmpdir(), 'whisper-native-'));
const java = name => process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 90000 });
try {
  const classes = join(out, 'classes'), dex = join(out, 'dex'); mkdirSync(classes); mkdirSync(dex);
  const sourceDir = join(root, 'android/java/org/leonz/whisper');
  const sources = readdirSync(sourceDir).filter(name => name.endsWith('.java')).map(name => join(sourceDir, name));
  const cp = [androidJar, ...dependencies.jars].join(delimiter);
  run(java('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', cp, '-d', classes, ...sources, join(root, 'tests/android/RealtimePolicyProbe.java')]);
  run(java('java'), ['-cp', [classes, cp].join(delimiter), 'org.leonz.whisper.RealtimePolicyProbe']);
  run(java('jar'), ['cf', join(out, 'classes.jar'), '-C', classes, '.']);
  run(java('java'), ['-cp', join(sdk, 'build-tools/35.0.0/lib/d8.jar'), 'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', androidJar, '--output', dex, join(out, 'classes.jar'), ...dependencies.jars]);
  console.log('Native SDK 35 compilation and API 26 D8: passed. Device lifecycle/Doze remains separate.');
} finally {
  // mkdtemp creates this exact test-owned absolute path under the OS temporary directory.
  rmSync(out, { recursive: true, force: true });
}
