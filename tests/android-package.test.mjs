import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyAndroidPackage } from '../scripts/verify-android-package.mjs';
import { unzipSync, zipSync } from 'fflate';
const manifest = JSON.parse(readFileSync('public/downloads/android-manifest.json', 'utf8'));
const apk = readFileSync('public/downloads/' + manifest.filename);

test('APK contains the current shared client and Android styles, rather than stale build assets', () => {
  const entries = unzipSync(apk);
  for (const name of ['app.js','style.css','index.html','brand-mark.svg']) assert.deepEqual(Buffer.from(entries['assets/' + name]), readFileSync('.runtime/android-build/assets/' + name));
  assert.equal(manifest.version, JSON.parse(readFileSync('package.json')).version);
});
test('released APK satisfies Android installer resource constraints', () => {
  const result = verifyAndroidPackage(apk);
  assert.equal(result.resources.compressed, false); assert.equal(result.resources.dataOffset % 4, 0);
});
test('the previously shipped compressed resource table is rejected', () => {
  // Reproduce the original repacking bug without depending on a host's old APK.
  const compressed = zipSync(unzipSync(apk), { level: 6 });
  assert.throws(() => verifyAndroidPackage(compressed), /resources.arsc must be uncompressed/);
});
