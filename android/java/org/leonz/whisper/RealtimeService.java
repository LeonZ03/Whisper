package org.leonz.whisper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/** User-visible, stoppable connection only: no message fetching, decryption or wake lock. */
public final class RealtimeService extends Service {
    static final String STOP = "org.leonz.whisper.STOP_CONNECTION";
    static final String GENERATION = "org.leonz.whisper.CONNECTION_GENERATION";
    private static final String CHANNEL = "background_connection";
    private static final int NOTIFICATION = 93;
    private final ScheduledExecutorService loop = Executors.newSingleThreadScheduledExecutor();
    private SessionState session;
    private int epoch, failures, attempt;
    private String userId = "", publicKey = "";
    private long startGeneration = -1, creationGeneration = -1;
    private volatile boolean ended;
    private boolean online;
    private long lastPing, waitingPong, handshakeStarted;
    private volatile HintSocket socket;
    private ScheduledFuture<?> retry;
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private Network activeNetwork;

    @Override public void onCreate() {
        super.onCreate(); session = SessionState.get(this);
        synchronized (session) {
            // Ownership is reserved here, but no socket work starts until the generation-bearing
            // onStartCommand proves that this was the latest validated foreground request.
            session.connectionOwner = this; creationGeneration = session.validatedGeneration;
        }
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "后台连接", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持聊天连接，不显示消息内容"); channel.setSound(null, null); channel.enableVibration(false);
        manager.createNotificationChannel(channel);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent activity = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 0, new Intent(this, RealtimeService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(getResources().getIdentifier("connection_icon", "drawable", getPackageName()))
            .setContentTitle("Whisper · 后台连接已开启").setContentText("点此返回聊天 · 可在“我的”中关闭")
            .setContentIntent(activity).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(null, "停止后台连接", stop).build()).build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(NOTIFICATION, notification);
        } catch (RuntimeException ignored) { ended = true; stopSelf(); return; }
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                final boolean ready = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                submit(() -> {
                    boolean switched = activeNetwork != null && !activeNetwork.equals(network);
                    activeNetwork = network;
                    if (ready && (!online || switched)) { online = true; disconnect(); scheduleRetry(1000 + (long) (Math.random() * 1000)); }
                    else if (!ready && online) { online = false; disconnect(); state("connecting"); }
                });
            }
            @Override public void onLost(Network network) {
                submit(() -> { if (network.equals(activeNetwork)) { online = false; activeNetwork = null; disconnect(); state("connecting"); } });
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
        loop.scheduleWithFixedDelay(() -> tick(), 1, 1, TimeUnit.SECONDS);
        loop.scheduleWithFixedDelay(() -> validate(), RealtimePolicy.VALIDATION, RealtimePolicy.VALIDATION, TimeUnit.MILLISECONDS);
        state("connecting");
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) { session.stop(true); stopSelf(); }
        else {
            final long requestedGeneration = intent == null ? -1 : intent.getLongExtra(GENERATION, -1);
            synchronized (session) {
                if (ended || session.stopping || requestedGeneration != session.startGeneration
                    || requestedGeneration != session.validatedGeneration || session.suppressed || session.revoked
                    || !RealtimePolicy.identity(session.userId, session.publicKey)) {
                    // A stale queued Intent must not stop a newer active generation of this instance.
                    if (!session.running) stopSelf(startId);
                    return START_NOT_STICKY;
                }
            }
            // A validated account switch can arrive while Android still owns this service instance.
            // Replace its scope on the serial loop; delayed callbacks from the old socket lose attempt/epoch checks.
            loop.execute(() -> {
                synchronized (session) {
                    if (ended || session.stopping || session.suppressed || session.revoked
                        || requestedGeneration != session.startGeneration || requestedGeneration != session.validatedGeneration) return;
                    if (startGeneration == requestedGeneration && session.running) return;
                    disconnect(); startGeneration = requestedGeneration; epoch = session.epoch.get();
                    userId = session.userId; publicKey = session.publicKey; failures = 0;
                    session.running = true; session.starting = false; session.serviceRequested = false;
                }
                // Network callbacks may have arrived before activation and were intentionally ignored.
                activeNetwork = connectivity.getActiveNetwork();
                NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(activeNetwork);
                online = capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                state("connecting");
                scheduleRetry(1000);
            });
        }
        // OS death and force-stop never restart credentials or a foreground service silently.
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    private boolean active() {
        synchronized (session) { return !ended && session.connectionOwner == this && session.running && !session.stopping
            && startGeneration == session.startGeneration && startGeneration == session.validatedGeneration && epoch == session.epoch.get() && !session.suppressed
            && userId.equals(session.userId) && publicKey.equals(session.publicKey) && !session.revoked; }
    }
    private void submit(Runnable work) { if (!ended) try { loop.execute(() -> { if (active()) work.run(); }); } catch (java.util.concurrent.RejectedExecutionException ignored) {} }
    private void state(String value) {
        synchronized (session) { if (!active()) return; session.state = value; }
        session.publish();
    }
    private void changed() {
        synchronized (session) { if (!active()) return; session.revision++; }
        session.publish();
    }
    private void revoke() { synchronized (session) { if (active()) session.clear(true); } }
    private void scheduleRetry(long delay) {
        if (!active() || !online) return;
        if (retry != null) retry.cancel(false);
        state("connecting"); retry = loop.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
    }
    private void retry() { disconnect(); scheduleRetry(RealtimePolicy.retryDelay(failures++, Math.random())); }
    private void connect() {
        if (!active() || !online || socket != null) return;
        CloudTransport.Result result = session.transport.request("/api/realtime/ticket", "POST", "{}", epoch, session.epoch);
        if (!active()) return;
        if (result.status == 401 || result.status == 403) { revoke(); return; }
        try {
            if (result.status != 200 || result.body.length() > 1024) { retry(); return; }
            JSONObject ticket = new JSONObject(result.body);
            String value = ticket.getString("ticket");
            if (!RealtimePolicy.ticket(value) || ticket.getLong("expiresAt") <= System.currentTimeMillis()) { retry(); return; }
            final int current = ++attempt;
            socket = new HintSocket(value, new HintSocket.Events() {
                public void opened() { submit(() -> { if (current == attempt) lastPing = SystemClock.elapsedRealtime(); }); }
                public void message(String message) { submit(() -> { if (current == attempt) receive(message); }); }
                public void closed(int code) { submit(() -> { if (current == attempt) { if (code != 1008 || validate()) retry(); } }); }
            });
            handshakeStarted = SystemClock.elapsedRealtime(); socket.connect();
        } catch (Exception ignored) { retry(); }
    }
    private void receive(String message) {
        if (message.length() > 512) { retry(); return; }
        if ("pong".equals(message)) { waitingPong = 0; return; }
        try {
            JSONObject value = new JSONObject(message);
            if (value.optInt("version") != 1) return;
            if ("ready".equals(value.optString("type"))) { handshakeStarted = 0; failures = 0; state("open"); changed(); }
            else if ("changed".equals(value.optString("type"))) changed();
        } catch (Exception ignored) { retry(); }
    }
    private void tick() {
        if (!active()) return;
        long now = SystemClock.elapsedRealtime();
        if (handshakeStarted > 0 && now - handshakeStarted > 20000) { retry(); return; }
        if (socket == null || !socket.isOpen()) return;
        if (waitingPong > 0 && now - waitingPong >= RealtimePolicy.PONG_TIMEOUT) { retry(); return; }
        if (waitingPong == 0 && now - lastPing >= RealtimePolicy.HEARTBEAT) {
            try { socket.send("ping"); waitingPong = now; lastPing = now; } catch (Exception ignored) { retry(); }
        }
    }
    private boolean validate() {
        if (!active() || !online) return false;
        CloudTransport.Result result = session.transport.request("/api/account/me", "GET", "", epoch, session.epoch);
        if (!active()) return false;
        if (result.status == 401 || result.status == 403 || result.status == 200 && !SessionState.matches(result, userId, publicKey)) { revoke(); return false; }
        // Transient failure is not revocation. Reconnect to revalidate before more hints.
        if (result.status != 200) { retry(); return false; }
        return true;
    }
    private void disconnect() {
        attempt++; if (retry != null) { retry.cancel(false); retry = null; }
        HintSocket previous = socket; socket = null; waitingPong = 0; handshakeStarted = 0;
        if (previous != null) { try { previous.terminate(); } catch (Exception ignored) {} }
    }
    @Override public void onDestroy() {
        ended = true;
        HintSocket previous = socket;
        if (previous != null) try { previous.terminate(); } catch (Exception ignored) {}
        if (connectivity != null && networkCallback != null) connectivity.unregisterNetworkCallback(networkCallback);
        // The epoch and ended checks stop in-flight HTTPS replies from reviving the socket.
        loop.execute(this::disconnect); loop.shutdown();
        synchronized (session) {
            if (session.connectionOwner == this) {
                session.connectionOwner = null; session.running = false; session.stopping = false; session.serviceRequested = false;
                // If a newer validation already exists, don't cancel its starting marker.
                if (!session.starting || startGeneration == session.startGeneration || creationGeneration == session.startGeneration) {
                    session.starting = false; session.state = "stopped";
                }
            }
        }
        session.publish(); stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy();
    }
}
