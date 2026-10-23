package org.leonz.whisper;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Process-owned cookie and connection state. Never retains an Activity or message content. */
final class SessionState {
    interface Listener { void changed(String state); }
    private static SessionState instance;
    static synchronized SessionState get(Context context) {
        if (instance == null) instance = new SessionState(context.getApplicationContext());
        return instance;
    }
    final Context context;
    final AtomicInteger epoch = new AtomicInteger();
    final CloudTransport transport;
    final SessionVault vault;
    final Handler main = new Handler(Looper.getMainLooper());
    String userId = "", publicKey = "", state = "stopped";
    long revision, startGeneration, validatedGeneration = -1;
    boolean revoked, suppressed, starting, running, stopping, serviceRequested;
    Object connectionOwner;
    private Listener listener;

    private SessionState(Context context) {
        this.context = context;
        // Set before Java-WebSocket initializes any logger. Never ship a logging backend.
        System.setProperty("slf4j.provider", "org.slf4j.nop.NOPServiceProvider");
        System.setProperty("slf4j.internal.verbosity", "ERROR");
        transport = new CloudTransport(Build.MANUFACTURER + " " + Build.MODEL + " / Android " + Build.VERSION.RELEASE);
        vault = new SessionVault(context);
        suppressed = context.getSharedPreferences("connection", Context.MODE_PRIVATE).getBoolean("suppressed", false);
    }
    synchronized void listen(Listener value) { listener = value; }
    synchronized void unlisten(Listener value) { if (listener == value) listener = null; }
    synchronized String snapshot() {
        try {
            JSONObject value = new JSONObject(); value.put("state", state); value.put("revision", revision);
            value.put("userId", userId); value.put("revoked", revoked); value.put("suppressed", suppressed);
            return value.toString();
        } catch (Exception ignored) { return "{}"; }
    }
    void publish() {
        // Read on delivery, not when queued: an old revoked event must not lock a new login of the same account.
        main.post(() -> { Listener target; String value; synchronized (this) { target = listener; value = snapshot(); } if (target != null) target.changed(value); });
    }
    synchronized void suppress(boolean value) {
        suppressed = value;
        context.getSharedPreferences("connection", Context.MODE_PRIVATE).edit().putBoolean("suppressed", value).apply();
    }
    void stop(boolean suppress) {
        synchronized (this) { if (suppress) suppress(true); invalidateStart(); }
        stopOwnedService(); publish();
    }
    void clear(boolean wasRevoked) {
        synchronized (epoch) { epoch.incrementAndGet(); transport.clearSession(); vault.clear(); }
        synchronized (this) { revoked = wasRevoked; invalidateStart(); }
        stopOwnedService(); publish();
    }
    private void invalidateStart() {
        startGeneration++; validatedGeneration = -1;
        stopping = stopping || connectionOwner != null || serviceRequested;
        starting = false; running = false; state = "stopped";
    }
    private void stopOwnedService() {
        // Serialize Android lifecycle requests on the main thread. An obsolete queued stop
        // cannot stop a replacement after the old instance has completed onDestroy.
        main.post(() -> {
            synchronized (this) {
                if (stopping && !context.stopService(new Intent(context, RealtimeService.class)) && connectionOwner == null) {
                    // A start cancelled before Android created the service has no onDestroy callback.
                    stopping = false; serviceRequested = false;
                }
            }
            publish();
        });
    }
    synchronized boolean currentStart(long generation, int expectedEpoch) {
        return generation == startGeneration && expectedEpoch == epoch.get() && !suppressed && !revoked && !stopping;
    }
    void failStart(long generation) {
        synchronized (this) {
            if (generation != startGeneration) return;
            starting = false; validatedGeneration = -1; state = "stopped";
        }
        publish();
    }
    static boolean matches(CloudTransport.Result result, String id, String key) {
        if (result.status != 200 || result.body.length() > 16384) return false;
        try {
            JSONObject user = new JSONObject(result.body);
            return id.equals(user.optString("id")) && key.equals(user.optString("publicKey"))
                && "member".equals(user.optString("role")) && "active".equals(user.optString("status"))
                && user.has("mustChangePassword") && !user.getBoolean("mustChangePassword");
        } catch (Exception ignored) { return false; }
    }
}
