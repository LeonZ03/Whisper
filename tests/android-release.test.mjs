import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageAndroidRelease, validateAndroidRelease, allowedReleaseRedirect } from '../scripts/android-release.mjs';
const bytes = Buffer.alloc(4096, 10);
const release = { version: '0.6.1', build: 1, versionCode: 60101, applicationId: 'org.leonz.whisper', server: 'https://whisper.leonz03.dpdns.org',
  filename: 'whisper-android-0.6.1-r1.apk', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
test('Android cloud release metadata rejects inconsistent and external inputs', () => {
  assert.equal(validateAndroidRelease(release), release);
  for (const change of [{ filename: '../data/file' }, { versionCode: 60102 }, { applicationId: 'other.app' }, { server: 'https://evil.example' }, { bytes: 26 * 1024 * 1024 }])
    assert.throws(() => validateAndroidRelease({ ...release, ...change }));
  assert.equal(allowedReleaseRedirect('https://release-assets.githubusercontent.com/github-production-release-asset/123/file?sig=public'), true);
  for (const url of ['http://release-assets.githubusercontent.com/github-production-release-asset/1', 'https://evil.example/file', 'https://user@release-assets.githubusercontent.com/github-production-release-asset/1'])
    assert.equal(allowedReleaseRedirect(url), false);
});
test('Cloud serves verified APK bytes itself; bad release cannot produce an update manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-android-release-'));
  try {
    mkdirSync(join(dir, 'android')); writeFileSync(join(dir, 'android/published-release.json'), JSON.stringify(release));
    let requests = 0;
    await stageAndroidRelease(dir, join(dir, 'assets'), async url => { requests++; assert.match(url, /github\.com\/LeonZ03\/Whisper\/releases\/download\/v0\.6\.1\//); return new Response(bytes); });
    assert.equal(requests, 1); assert.deepEqual(readFileSync(join(dir, 'assets/downloads', release.filename)), bytes);
    assert.equal(JSON.parse(readFileSync(join(dir, 'assets/downloads/android-manifest.json'))).server, release.server);
    await stageAndroidRelease(dir, join(dir, 'assets'), () => { throw Error('Verified cache must avoid network'); });
    writeFileSync(join(dir, '.runtime/android-releases', release.sha256 + '.apk'), Buffer.alloc(1000));
    await assert.rejects(stageAndroidRelease(dir, join(dir, 'bad'), async () => new Response(Buffer.alloc(4096))), /SHA-256/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
