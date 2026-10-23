package org.leonz.whisper;

/** Pure policy shared by the service and host-JVM tests. Times are monotonic milliseconds. */
final class RealtimePolicy {
    static final long HEARTBEAT = 45000, PONG_TIMEOUT = 15000, VALIDATION = 90000;
    static long retryDelay(int failures, double random) {
        long cap = Math.min(60000L, 1000L << Math.min(6, Math.max(0, failures)));
        return Math.max(1000L, Math.min(60000L, (long) (cap * (0.5 + Math.max(0, Math.min(1, random)) * 0.5))));
    }
    static boolean identity(String id, String key) {
        return id != null && id.matches("[0-9a-f-]{36}") && key != null && key.matches("[A-Za-z0-9+/]{43}=");
    }
    static boolean ticket(String ticket) { return ticket != null && ticket.matches("[A-Za-z0-9_-]{43}"); }
}
