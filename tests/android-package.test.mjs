import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyAndroidPackage } from '../scripts/verify-android-package.mjs';
import { unzipSync, zipSync } from 'fflate';
const manifest = JSON.parse(readFileSync('public/downloads/android-manifest.json', 'utf8'));
const apk = readFileSync('public/downloads/' + manifest.filename);
test('released APK satisfies Android installer resource constraints', () => {
  const result = verifyAndroidPackage(apk);
  assert.equal(result.resources.compressed, false); assert.equal(result.resources.dataOffset % 4, 0);
});
test('the previously shipped compressed resource table is rejected', () => {
  // Reproduce the original repacking bug without depending on a host's old APK.
  const compressed = zipSync(unzipSync(apk), { level: 6 });
  assert.throws(() => verifyAndroidPackage(compressed), /resources.arsc must be uncompressed/);
});
