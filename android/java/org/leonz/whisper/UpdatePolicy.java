package org.leonz.whisper;

import java.net.URI;

/** Public release metadata only. No session, arbitrary URL or local path input. */
public final class UpdatePolicy {
    public static final String ORIGIN = "https://whisper.leonz03.dpdns.org";
    public static final String MANIFEST = ORIGIN + "/downloads/android-manifest.json";
    public static final long MAX_APK_BYTES = 64L * 1024 * 1024;
    public final String version, filename, sha256, url;
    public final long versionCode, bytes;
    public UpdatePolicy(String version, int build, long code, String applicationId, String filename, long bytes, String sha256) {
        if (version == null || !version.matches("[0-9]{1,3}\\.[0-9]{1,2}\\.[0-9]{1,2}") || build < 1 || build > 99)
            throw new IllegalArgumentException("Invalid release version");
        String[] parts = version.split("\\.");
        long expected = Long.parseLong(parts[0]) * 1000000 + Long.parseLong(parts[1]) * 10000 + Long.parseLong(parts[2]) * 100 + build;
        if (code != expected || !"org.leonz.whisper".equals(applicationId)
            || !("whisper-android-" + version + "-r" + build + ".apk").equals(filename)
            || bytes < 1000 || bytes > MAX_APK_BYTES || sha256 == null || !sha256.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("Invalid release metadata");
        this.version = version; this.versionCode = code; this.filename = filename; this.bytes = bytes; this.sha256 = sha256;
        this.url = ORIGIN + "/downloads/" + filename;
    }
    public static boolean allowedDownload(String value) {
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || uri.getRawUserInfo() != null || uri.getRawFragment() != null || uri.getRawQuery() != null
                || (uri.getPort() != -1 && uri.getPort() != 443)) return false;
            String host = uri.getHost(), path = uri.getRawPath();
            return "whisper.leonz03.dpdns.org".equals(host) && path != null && (value.equals(MANIFEST)
                || path.matches("/downloads/whisper-android-[0-9]+\\.[0-9]+\\.[0-9]+-r[0-9]+\\.apk"));
        } catch (Exception ignored) { return false; }
    }
}
