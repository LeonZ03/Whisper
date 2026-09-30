import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const origin = 'https://whisper.leonz03.dpdns.org';
const maxBytes = 25 * 1024 * 1024; // One Cloudflare Static Asset; fail before publication if exceeded.
export function validateAndroidRelease(value) {
  if (!value || !/^(0|[1-9]\d{0,2})\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/.test(value.version)
    || !Number.isInteger(value.build) || value.build < 1 || value.build > 99) throw Error('Invalid Android release version');
  const [major, minor, patch] = value.version.split('.').map(Number);
  if (value.versionCode !== major * 1_000_000 + minor * 10_000 + patch * 100 + value.build
    || value.applicationId !== 'org.leonz.whisper' || value.server !== origin
    || value.filename !== `whisper-android-${value.version}-r${value.build}.apk`
    || !Number.isInteger(value.bytes) || value.bytes < 1000 || value.bytes > maxBytes
    || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('Invalid Android release metadata');
  return value;
}
export function verifyAndroidRelease(bytes, release) {
  validateAndroidRelease(release);
  if (bytes.length !== release.bytes || createHash('sha256').update(bytes).digest('hex') !== release.sha256)
    throw Error('Android release SHA-256 or size mismatch');
}
export function allowedReleaseRedirect(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port
      && u.hostname === 'release-assets.githubusercontent.com' && u.pathname.startsWith('/github-production-release-asset/');
  } catch { return false; }
}
export async function stageAndroidRelease(root, assets, fetchImpl = fetch) {
  const release = validateAndroidRelease(JSON.parse(readFileSync(join(root, 'android/published-release.json'), 'utf8')));
  const local = join(root, 'public/downloads', release.filename), cacheDir = join(root, '.runtime/android-releases');
  const cache = join(cacheDir, release.sha256 + '.apk');
  let bytes;
  for (const path of [cache, local]) {
    if (!existsSync(path)) continue;
    try { const candidate = readFileSync(path); verifyAndroidRelease(candidate, release); bytes = candidate; break; } catch { /* Refetch the pinned artifact. */ }
  }
  if (!bytes) {
    let url = `https://github.com/LeonZ03/Whisper/releases/download/v${release.version}/${release.filename}`;
    const signal = AbortSignal.timeout(180_000);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(url, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('location') || '', url).href;
        await response.body?.cancel();
        if (!allowedReleaseRedirect(next)) throw Error('Unexpected Android release redirect');
        url = next; continue;
      }
      if (!response.ok) throw Error('Pinned Android release download failed: ' + response.status);
      const declared = Number(response.headers.get('content-length'));
      if (declared && declared !== release.bytes) { await response.body?.cancel(); throw Error('Android release length mismatch'); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length; if (size > release.bytes) throw Error('Android release too large'); chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks); verifyAndroidRelease(bytes, release); break;
    }
    if (!bytes) throw Error('Android release redirect limit');
    mkdirSync(cacheDir, { recursive: true }); writeFileSync(cache, bytes);
  }
  const downloads = join(assets, 'downloads'); mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, release.filename), bytes);
  writeFileSync(join(downloads, 'android-manifest.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}
