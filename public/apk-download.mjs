const link = document.getElementById('download-apk');
const info = document.getElementById('release-info');
const retry = document.getElementById('retry-download');

async function loadRelease() {
  retry.hidden = true;
  link.removeAttribute('href'); link.removeAttribute('download'); link.setAttribute('aria-disabled', 'true');
  info.textContent = '正在读取版本信息…';
  try {
    const response = await fetch('/downloads/android-manifest.json', { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Unavailable');
    const release = await response.json();
    if (!release || !/^(0|[1-9]\d{0,2})\.(0|[1-9]\d?)\.(0|[1-9]\d?)$/.test(release.version)
      || !Number.isInteger(release.build) || release.build < 1 || release.build > 99
      || release.applicationId !== 'org.leonz.whisper'
      || release.filename !== `whisper-android-${release.version}-r${release.build}.apk`
      || !Number.isInteger(release.bytes) || release.bytes < 1000 || release.bytes > 25 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(release.sha256)) throw Error('Invalid release');
    const size = release.bytes < 1024 * 1024 ? `${Math.ceil(release.bytes / 1024)} KB` : `${(release.bytes / 1024 / 1024).toFixed(1)} MB`;
    info.textContent = `v${release.version} · ${size} · Android 8.0 及以上`;
    link.href = `/downloads/${release.filename}`;
    link.download = release.filename;
    link.removeAttribute('aria-disabled');
  } catch {
    info.textContent = '暂时无法读取安装包信息，请重试。';
    retry.hidden = false;
  }
}
retry.addEventListener('click', loadRelease);
void loadRelease();
