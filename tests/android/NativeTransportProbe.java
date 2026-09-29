package org.leonz.whisper;
import java.util.concurrent.atomic.AtomicInteger;

/** Executes the shipped native HTTPS class on the host JVM; not an Android ART test. */
public final class NativeTransportProbe {
    public static void main(String[] args) {
        CloudTransport transport = new CloudTransport("isolated-native-check");
        AtomicInteger epoch = new AtomicInteger();
        String uuid = "11111111-1111-4111-8111-111111111111";
        String[] allowed = { "/api/sync", "/api/sync?cursor=0", "/api/sync?conversationId=" + uuid,
            "/api/sync?conversationId=" + uuid + "&cursor=123" };
        for (String path : allowed) if (!CloudTransport.allowed(path, "GET")) throw new AssertionError("Missing incremental endpoint");
        if (!CloudTransport.allowed("/api/realtime/ticket", "POST")) throw new AssertionError("Missing ticket endpoint");
        String[] denied = { "https://example.com/api/sync", "//example.com/api/sync", "/api/../sync", "/api/sync?token=secret",
            "/api/sync?cursor=1&extra=1", "/api/sync?conversationId=" + uuid + "&cookie=secret", "/api/realtime?ticket=secret" };
        for (String path : denied) if (CloudTransport.allowed(path, "GET")) throw new AssertionError("Unexpected request access");
        if (CloudTransport.allowed("/api/realtime/ticket", "GET") || CloudTransport.allowed("/api/sync", "POST")) throw new AssertionError("Unexpected method");
        transport.restoreCookie("invalid"); if (!transport.snapshotCookie().isEmpty()) throw new AssertionError("Invalid cookie accepted");
        if (transport.request("/api/../sync", "GET", "", 0, epoch).status != 400) throw new AssertionError("Path not rejected before network");
        if (args.length == 1 && "--live-health".equals(args[0])) {
            CloudTransport.Result health = transport.request("/api/health", "GET", "", 0, epoch);
            if (health.status != 200 || !health.body.contains("\"version\"")) throw new AssertionError("Native TLS health failed");
            System.out.println("Native HTTPS health: 200; standard certificate and hostname validation.");
        }
        transport.clearSession(); System.out.println("Native HTTPS sync/ticket allowlist: passed. Android device/ART testing remains separate.");
    }
}
