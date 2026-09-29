package org.leonz.whisper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.HttpsURLConnection;

/** Same public API as web/CLI; exact origin, normal certificate validation. */
final class CloudTransport {
    static final String SERVER = "https://whisper.leonz03.dpdns.org";
    private String cookie = "";
    private final String device;
    CloudTransport() { this("Android"); }
    CloudTransport(String device) { this.device = device.replaceAll("[^ -~]", "").substring(0, Math.min(128, device.replaceAll("[^ -~]", "").length())); }
    // An image is base64 inside the encrypted payload and base64 again in its
    // envelope; 1 MB prepared bytes can occupy about 1.78 MB on the wire.
    static final int BODY_LIMIT = 2_000_000;
    static final int RESPONSE_LIMIT = 8_000_000;
    static final class Result {
        final int status; final String body;
        Result(int status, String body) { this.status = status; this.body = body; }
    }
    synchronized void clearSession() { cookie = ""; }
    synchronized String snapshotCookie() { return cookie; }
    synchronized void restoreCookie(String value) {
        if (value != null && value.matches("whisper_session=[A-Za-z0-9_-]{43}")) cookie = value;
    }
    private synchronized String sessionCookie() { return cookie; }
    static boolean allowed(String path, String method) {
        if (path == null || method == null) return false;
        String uuid = "[0-9a-f-]{36}";
        if ("GET".equals(method)) return path.equals("/api/health") || path.equals("/api/account/me") || path.equals("/api/account/sessions")
            || path.matches("/api/sync(?:\\?(?:conversationId=" + uuid + "(?:&cursor=[0-9]{1,16})?|cursor=[0-9]{1,16}))?")
            || path.matches("/api/auth/salt\\?username=[a-z0-9_]{3,24}") || path.equals("/api/conversations")
            || path.matches("/api/conversations/" + uuid + "/messages")
            || path.matches("/api/admin/(members|logins)(\\?before=[0-9]+)?");
        if ("POST".equals(method)) return path.matches("/api/auth/(login|logout|register|recover)")
            || path.equals("/api/realtime/ticket")
            || path.equals("/api/account/password") || path.equals("/api/conversations")
            || path.matches("/api/conversations/" + uuid + "/(messages|clear)")
            || path.matches("/api/messages/" + uuid + "/open")
            || path.matches("/api/admin/members/" + uuid + "/(approve|reject|remove|reset)");
        return "DELETE".equals(method) && path.matches("/api/messages/" + uuid);
    }
    Result request(String path, String method, String body, int epoch, AtomicInteger activeEpoch) {
        if (!allowed(path, method) || body == null || body.length() > BODY_LIMIT) return new Result(400, "{\"error\":\"无效请求\"}");
        HttpsURLConnection connection = null;
        try {
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            if (payload.length > BODY_LIMIT) return new Result(413, "{\"error\":\"请求过大\"}");
            connection = (HttpsURLConnection) new URL(SERVER + path).openConnection();
            connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
            connection.setConnectTimeout(12000); connection.setReadTimeout(20000); connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Origin", SERVER);
            connection.setRequestProperty("X-Whisper-Client", "app"); connection.setRequestProperty("X-Whisper-Device", device);
            connection.setRequestProperty("User-Agent", "WhisperApp/Android (" + device + ")");
            connection.setRequestProperty("Cache-Control", "no-store");
            String session = sessionCookie(); if (!session.isEmpty()) connection.setRequestProperty("Cookie", session);
            if (!"GET".equals(method)) {
                connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("X-Whisper-Request", "1");
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(payload.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(payload); }
            }
            java.util.Arrays.fill(payload, (byte) 0);
            int status = connection.getResponseCode();
            // Never expose session headers to JavaScript or let a stale login revive a locked session.
            synchronized (this) {
                if (epoch == activeEpoch.get()) for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (header.getKey() == null || !"set-cookie".equalsIgnoreCase(header.getKey())) continue;
                    for (String value : header.getValue()) {
                        String first = value.split(";", 2)[0];
                        if (first.matches("whisper_session=[A-Za-z0-9_-]{43}")) cookie = first;
                        else if (first.equals("whisper_session=")) cookie = "";
                    }
                }
            }
            if (status >= 300 && status < 400) return new Result(502, "{\"error\":\"服务地址发生跳转，请更新应用\"}");
            String contentType = connection.getHeaderField("Content-Type");
            if (contentType == null || !contentType.toLowerCase(java.util.Locale.ROOT).startsWith("application/json")) return new Result(502, "{\"error\":\"服务返回无效响应\"}");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (stream == null) return new Result(502, "{\"error\":\"服务未返回响应\"}");
            try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > RESPONSE_LIMIT) throw new java.io.IOException("Response limit");
                    output.write(buffer, 0, count);
                }
                return new Result(status, new String(output.toByteArray(), StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) { return new Result(0, ""); }
        finally { if (connection != null) connection.disconnect(); }
    }
}
