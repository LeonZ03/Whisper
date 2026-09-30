import org.leonz.whisper.UpdatePolicy;
public final class UpdatePolicyProbe {
    private static void check(boolean value) { if (!value) throw new AssertionError("Update policy failed"); }
    public static void main(String[] args) {
        String hash = new String(new char[64]).replace('\0', 'a');
        UpdatePolicy release = new UpdatePolicy("0.6.1", 1, 60101, "org.leonz.whisper", "whisper-android-0.6.1-r1.apk", 240000, hash);
        check(release.url.equals("https://whisper.leonz03.dpdns.org/downloads/whisper-android-0.6.1-r1.apk"));
        check(UpdatePolicy.allowedDownload(release.url)); check(UpdatePolicy.allowedDownload(UpdatePolicy.MANIFEST));
        for (String url : new String[]{"http://whisper.leonz03.dpdns.org/downloads/android-manifest.json", release.url + "?cookie=x",
            release.url + "#x", release.url.replace("https://", "https://user@"), release.url.replace(".org/", ".org.evil.example/"),
            "https://github.com/LeonZ03/Whisper/releases/latest/download/android-manifest.json",
            "https://whisper.leonz03.dpdns.org/downloads/../api/health"}) check(!UpdatePolicy.allowedDownload(url));
        boolean rejected = false;
        try { new UpdatePolicy("0.6.1", 1, 60102, "org.leonz.whisper", release.filename, release.bytes, hash); }
        catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected);
        System.out.println("Android update policy: origin, metadata, URL boundary checks passed");
    }
}
