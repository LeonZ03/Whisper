import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReleaseVersions, parseReleaseVersion, validateLinuxReleaseLocation, validateManifest } from '../cli/update.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Linux updater recognizes the direct versions/<sha> install layout', () => {
  const versions = join(tmpdir(), 'whisper-layout-fixture', 'versions');
  const release = join(versions, 'a'.repeat(64));
  assert.equal(validateLinuxReleaseLocation(versions, release, release), release);
  assert.throws(() => validateLinuxReleaseLocation(versions, join(release, 'Whisper-CLI'), join(release, 'Whisper-CLI')));
  assert.throws(() => validateLinuxReleaseLocation(versions, release, join(versions, 'b'.repeat(64))));
});

test('update compares supported strict numeric versions without downgrades', () => {
  assert.equal(compareReleaseVersions('0.6.9', '0.6.10'), -1);
  assert.equal(compareReleaseVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareReleaseVersions('0.6.1', '0.6.1'), 0);
  assert.throws(() => parseReleaseVersion('v0.6.1'));
  assert.throws(() => parseReleaseVersion('0.6.1-beta.1'));
  assert.throws(() => parseReleaseVersion('01.6.1'));
});

test('update manifest must match the exact target platform and bounded archive metadata', () => {
  const sha = 'a'.repeat(64);
  const windows = { version: '0.6.2', platform: 'windows-x64', filename: 'whisper-cli-windows-x64.zip', bytes: 1_000_000, sha256: sha, installerSha256: sha };
  const linux = { ...windows, platform: 'linux-arm64', filename: 'whisper-cli-linux-arm64.tar.gz' };
  assert.equal(validateManifest(windows, 'win32', 'x64'), windows);
  assert.equal(validateManifest(linux, 'linux', 'arm64'), linux);
  assert.throws(() => validateManifest({ ...linux, filename: 'https://attacker/archive' }, 'linux', 'arm64'));
  assert.throws(() => validateManifest({ ...linux, bytes: 268_435_457 }, 'linux', 'arm64'));
  assert.throws(() => validateManifest({ ...linux, version: '0.6.2+metadata' }, 'linux', 'arm64'));
});
