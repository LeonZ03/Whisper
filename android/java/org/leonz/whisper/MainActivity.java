package org.leonz.whisper;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Only bundled code can access the bridge. Login material is sealed by Android Keystore. */
public final class MainActivity extends Activity {
    static final String ASSET_ORIGIN = "https://appassets.androidplatform.net";
    private WebView web;
    private CloudTransport transport;
    private SessionVault vault;
    private AppUpdater updater;
    private final ExecutorService requests = Executors.newFixedThreadPool(3);
    private final AtomicInteger sessionEpoch = new AtomicInteger();
    private ValueCallback<Uri[]> fileCallback;
    private boolean destroyed;
    private boolean foreground;
    private boolean networkReady;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private static final int IMAGE_PICKER = 71;
    private static final Map<String, String> ASSETS = new HashMap<>();
    static {
        ASSETS.put("/index.html", "text/html"); ASSETS.put("/", "text/html");
        ASSETS.put("/style.css", "text/css"); ASSETS.put("/app.js", "text/javascript");
        ASSETS.put("/brand-mark.svg", "image/svg+xml");
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(null); // Never restore a WebView form/session from saved state.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= 33) {
            setRecentsScreenshotEnabled(false);
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> js("globalThis.whisperAndroidBack?.()"));
        }
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        vault = new SessionVault(this);
        updater = new AppUpdater(this);
        transport = new CloudTransport(Build.MANUFACTURER + " " + Build.MODEL + " / Android " + Build.VERSION.RELEASE);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(250, 252, 251));
        web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); // Public-key pins only.
        settings.setAllowFileAccess(false);
        // The OS picker grants one user-selected content:// image, never storage access.
        // All document/frame navigation is still blocked by the client and CSP.
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE); settings.setSaveFormData(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().removeAllCookies(null);
        web.addJavascriptInterface(new NativeBridge(), "WhisperNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // There is no external navigation, file:// access, or untrusted frame in this client.
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl(); String path = uri.getPath();
                if (!"GET".equals(request.getMethod()) || !"https".equals(uri.getScheme())
                    || !"appassets.androidplatform.net".equals(uri.getHost()) || uri.getPort() != -1
                    || uri.getQuery() != null || !ASSETS.containsKey(path)) return denied();
                try {
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; connect-src wss://whisper.leonz03.dpdns.org/api/realtime; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
                    InputStream stream = getAssets().open("/".equals(path) ? "index.html" : path.substring(1));
                    return new WebResourceResponse(ASSETS.get(path), "UTF-8", 200, "OK", headers, stream);
                } catch (Exception ignored) { return denied(); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                AlertDialog dialog = new AlertDialog.Builder(MainActivity.this).setTitle("Whisper")
                    .setMessage(message).setPositiveButton("继续", (d, which) -> result.confirm())
                    .setNegativeButton("取消", (d, which) -> result.cancel()).setOnCancelListener(d -> result.cancel()).create();
                dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE); dialog.show(); return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*");
                try { startActivityForResult(intent, IMAGE_PICKER); }
                catch (Exception ignored) { fileCallback = null; callback.onReceiveValue(null); }
                return true;
            }
        });
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.rgb(250, 252, 251));
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            }
            return insets;
        });
        web.loadUrl(ASSET_ORIGIN + "/index.html");
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                boolean ready = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                runOnUiThread(() -> {
                    boolean restored = ready && !networkReady; networkReady = ready;
                    if (foreground && restored) js("globalThis.whisperAndroidNetworkRestored?.()");
                });
            }
            @Override public void onLost(Network network) {
                runOnUiThread(() -> { networkReady = false; if (foreground) js("globalThis.whisperAndroidNetworkLost?.()"); });
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
    }
    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }
    private void js(String script) { if (!destroyed && web != null) web.evaluateJavascript(script, null); }
    @Override public void onBackPressed() { js("globalThis.whisperAndroidBack?.()"); }
    @Override protected void onPause() { foreground = false; js("globalThis.whisperAndroidPause?.()"); super.onPause(); }
    @Override protected void onStop() {
        // onPause clears visible content; the device-bound login survives backgrounding.
        super.onStop();
    }
    @Override protected void onResume() { super.onResume(); foreground = true; if (web != null) js("globalThis.whisperAndroidResume?.()"); }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 72 && updater != null) { updater.installPending(); return; }
        if (requestCode == IMAGE_PICKER && fileCallback != null) {
            ValueCallback<Uri[]> callback = fileCallback; fileCallback = null;
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            callback.onReceiveValue(uri != null && "content".equals(uri.getScheme()) ? new Uri[]{uri} : null);
        }
    }
    @Override protected void onSaveInstanceState(Bundle state) { /* No session or form persistence. */ }
    @Override protected void onDestroy() {
        if (connectivity != null && networkCallback != null) connectivity.unregisterNetworkCallback(networkCallback);
        destroyed = true; sessionEpoch.incrementAndGet(); transport.clearSession(); requests.shutdownNow();
        if (updater != null) updater.destroy();
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        web.removeJavascriptInterface("WhisperNative"); web.clearCache(true); web.clearHistory(); web.destroy(); web = null;
        super.onDestroy();
    }
    public final class NativeBridge {
        @JavascriptInterface public void checkUpdate(boolean manual) { runOnUiThread(() -> { if (!destroyed) updater.check(manual); }); }
        @JavascriptInterface public void request(String id, String path, String method, String body) {
            if (id == null || !id.matches("[0-9]{1,10}") || destroyed) return;
            final int epoch = sessionEpoch.get();
            requests.execute(() -> {
                CloudTransport.Result result = transport.request(path, method, body, epoch, sessionEpoch);
                if (epoch != sessionEpoch.get() || destroyed) return;
                runOnUiThread(() -> { if (epoch == sessionEpoch.get()) js("globalThis.whisperAndroidResponse(" + JSONObject.quote(id) + "," + result.status + "," + JSONObject.quote(result.body) + ")"); });
            });
        }
        @JavascriptInterface public boolean saveLogin(String identity) {
            synchronized (sessionEpoch) {
                if (destroyed) return false;
                try { vault.save(transport.snapshotCookie(), identity); return true; }
                catch (Exception ignored) { return false; }
            }
        }
        @JavascriptInterface public String restoreLogin() {
            synchronized (sessionEpoch) {
                if (destroyed) return "";
                try {
                    JSONObject login = vault.load(); if (login == null) return "";
                    transport.restoreCookie(login.getString("cookie")); return login.getJSONObject("identity").toString();
                } catch (Exception ignored) { vault.clear(); transport.clearSession(); return ""; }
            }
        }
        @JavascriptInterface public void clearSession() {
            synchronized (sessionEpoch) { sessionEpoch.incrementAndGet(); transport.clearSession(); vault.clear(); }
        }
        @JavascriptInterface public void exit() { runOnUiThread(() -> finish()); }
    }
}
