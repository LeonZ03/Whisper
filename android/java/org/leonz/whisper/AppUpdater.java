package org.leonz.whisper;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** Independent credential-free HTTPS updater; Android always confirms installation. */
public final class AppUpdater {
    private final Activity activity;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();
    private volatile boolean destroyed, cancelled;
    private volatile HttpURLConnection connection;
    private AlertDialog dialog;
    private UpdatePolicy pendingInstall;
    private long offeredVersion;
    public AppUpdater(Activity activity) { this.activity = activity; }
    private void ui(Runnable action) { activity.runOnUiThread(() -> { if (!destroyed && !activity.isFinishing()) action.run(); }); }
    private boolean visible() { return !activity.isFinishing() && activity.hasWindowFocus(); }
    private AlertDialog show(AlertDialog.Builder builder) {
        if (dialog != null) dialog.dismiss();
        dialog = builder.create(); dialog.show(); dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE); return dialog;
    }
    private void dismiss() { if (dialog != null) { dialog.dismiss(); dialog = null; } }
    private void message(String text) { show(new AlertDialog.Builder(activity).setTitle("Whisper 更新").setMessage(text).setPositiveButton("知道了", null)); }
    private PackageInfo installed() throws Exception {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES);
    }
    private static long code(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private HttpURLConnection open(String target) throws Exception {
        if (cancelled || destroyed || !UpdatePolicy.allowedDownload(target)) throw new Exception("Download unavailable");
        HttpURLConnection c = (HttpURLConnection) new URL(target).openConnection(); connection = c;
        c.setConnectTimeout(15000); c.setReadTimeout(20000); c.setInstanceFollowRedirects(false); c.setUseCaches(false);
        c.setRequestProperty("User-Agent", "Whisper-Android-Updater"); c.setRequestProperty("Accept-Encoding", "identity");
        try { if (c.getResponseCode() == 200) return c; throw new Exception("Release unavailable"); }
        catch (Exception error) { c.disconnect(); throw error; }
    }
    public void check(boolean manual) {
        if (destroyed || !busy.compareAndSet(false, true)) return;
        if (!manual) {
            long previous = activity.getPreferences(0).getLong("update_checked_at", 0);
            if (System.currentTimeMillis() - previous < 6 * 60 * 60 * 1000L) { busy.set(false); return; }
        }
        cancelled = false;
        if (manual) show(new AlertDialog.Builder(activity).setTitle("Whisper 更新").setMessage("正在检查更新…").setCancelable(false));
        worker.execute(() -> {
            try {
                HttpURLConnection c = open(UpdatePolicy.MANIFEST);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                try (InputStream in = c.getInputStream()) {
                    byte[] buffer = new byte[4096]; int n; long deadline = android.os.SystemClock.elapsedRealtime() + 30000;
                    while ((n = in.read(buffer)) >= 0) { if (out.size() + n > 65536 || destroyed || cancelled || android.os.SystemClock.elapsedRealtime() > deadline) throw new Exception("Invalid manifest"); out.write(buffer, 0, n); }
                } finally { c.disconnect(); }
                JSONObject value = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
                UpdatePolicy release = new UpdatePolicy(value.getString("version"), value.getInt("build"), value.getLong("versionCode"),
                    value.getString("applicationId"), value.getString("filename"), value.getLong("bytes"), value.getString("sha256"));
                PackageInfo installed = installed(); long current = code(installed);
                activity.getPreferences(0).edit().putLong("update_checked_at", System.currentTimeMillis()).apply();
                ui(() -> {
                    busy.set(false);
                    if (manual) dismiss();
                    if (release.versionCode <= current) { if (manual) message("已是最新版本 v" + installed.versionName + "。"); return; }
                    if (!manual && (!visible() || offeredVersion == release.versionCode)) return;
                    offeredVersion = release.versionCode;
                    show(new AlertDialog.Builder(activity).setTitle("发现新版本 v" + release.version)
                        .setMessage("下载后由系统确认更新，保留现有账号和应用数据。")
                        .setNegativeButton("稍后", null).setPositiveButton("下载更新", (d, which) -> download(release)));
                });
            } catch (Exception ignored) { ui(() -> { busy.set(false); if (manual) message("暂时无法检查更新，请检查网络后重试。"); }); }
            finally { connection = null; }
        });
    }
    private void download(UpdatePolicy release) {
        if (destroyed || !busy.compareAndSet(false, true)) return;
        cancelled = false;
        LinearLayout layout = new LinearLayout(activity); layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * activity.getResources().getDisplayMetrics().density); layout.setPadding(padding, padding / 2, padding, padding / 2);
        ProgressBar bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal); bar.setMax(100);
        TextView label = new TextView(activity); label.setText("正在下载更新…"); layout.addView(label); layout.addView(bar);
        show(new AlertDialog.Builder(activity).setTitle("更新到 v" + release.version).setView(layout).setCancelable(false)
            .setNegativeButton("取消", (d, which) -> { cancelled = true; HttpURLConnection c = connection; if (c != null) c.disconnect(); }));
        worker.execute(() -> {
            File folder = new File(activity.getCacheDir(), "updates"), part = new File(folder, "package.part"), apk = new File(folder, "package.apk");
            try {
                if (!folder.isDirectory() && !folder.mkdirs()) throw new Exception("Storage unavailable");
                HttpURLConnection c = open(release.url);
                if (c.getContentLengthLong() > 0 && c.getContentLengthLong() != release.bytes) { c.disconnect(); throw new Exception("Size mismatch"); }
                MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0, lastUi = 0;
                long deadline = android.os.SystemClock.elapsedRealtime() + 180000;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[32768]; int n;
                    while ((n = in.read(buffer)) >= 0) {
                        count += n; if (count > release.bytes || cancelled || destroyed || android.os.SystemClock.elapsedRealtime() > deadline) throw new Exception("Download cancelled");
                        digest.update(buffer, 0, n); out.write(buffer, 0, n);
                        long now = System.currentTimeMillis();
                        if (now - lastUi > 250 || count == release.bytes) { final int percent = (int)(count * 100 / release.bytes); ui(() -> { bar.setProgress(percent); label.setText("正在下载更新… " + percent + "%"); }); lastUi = now; }
                    }
                    out.getFD().sync();
                } finally { c.disconnect(); }
                if (count != release.bytes || !hex(digest.digest()).equals(release.sha256) || cancelled) throw new Exception("Integrity check failed");
                verifyPackage(part, release);
                if (apk.exists() && !apk.delete()) throw new Exception("Storage unavailable");
                if (!part.renameTo(apk)) throw new Exception("Storage unavailable");
                ui(() -> { busy.set(false); dismiss(); pendingInstall = release; installPending(); });
            } catch (Exception ignored) { part.delete(); ui(() -> { busy.set(false); if (!cancelled) message("更新未完成，下载或安装包校验失败，请稍后重试。"); }); }
            finally { connection = null; }
        });
    }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(); for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return out.toString(); }
    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] values = Build.VERSION.SDK_INT >= 28 && info.signingInfo != null ? info.signingInfo.getApkContentsSigners() : info.signatures;
        Set<String> result = new HashSet<>(); if (values != null) for (Signature value : values) result.add(hex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray()))); return result;
    }
    private void verifyPackage(File file, UpdatePolicy expected) throws Exception {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo candidate = activity.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), flags), current = installed();
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName) || code(candidate) != expected.versionCode
            || code(candidate) <= code(current) || !expected.version.equals(candidate.versionName)
            || signers(current).isEmpty() || !signers(current).equals(signers(candidate))) throw new Exception("Invalid APK identity");
    }
    public void installPending() {
        if (pendingInstall == null || destroyed) return;
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            show(new AlertDialog.Builder(activity).setTitle("允许安装 Whisper 更新")
                .setMessage("请在系统设置中允许 Whisper 安装更新，再返回继续。")
                .setNegativeButton("稍后", null).setPositiveButton("前往设置", (d, which) -> {
                    try { activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())), 72); }
                    catch (Exception ignored) { message("请在系统设置中允许 Whisper 安装应用后重试。"); }
                })); return;
        }
        try {
            verifyPackage(new File(activity.getCacheDir(), "updates/package.apk"), pendingInstall);
            activity.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(UpdateProvider.URI, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); pendingInstall = null;
        } catch (Exception ignored) { message("无法打开系统安装界面，请重新检查更新。"); }
    }
    public void destroy() { destroyed = true; cancelled = true; HttpURLConnection c = connection; if (c != null) c.disconnect(); worker.shutdownNow(); dismiss(); }
}
