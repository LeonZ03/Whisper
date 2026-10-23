package org.leonz.whisper;

import java.net.URI;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Collections;
import javax.net.ssl.SSLParameters;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.handshake.ServerHandshake;
import org.java_websocket.protocols.Protocol;

/** Fixed origin, system trust store and HTTPS hostname checks; no cookies or payloads. */
final class HintSocket extends WebSocketClient {
    interface Events {
        void opened(); void message(String value); void closed(int code);
    }
    private final Events events;
    private volatile boolean stopped;
    HintSocket(String ticket, Events events) {
        super(URI.create("wss://whisper.leonz03.dpdns.org/api/realtime"),
            new Draft_6455(Collections.emptyList(), Arrays.asList(new Protocol("whisper-realtime-v1"), new Protocol("ticket." + checked(ticket))), 1024),
            Collections.singletonMap("Origin", CloudTransport.SERVER), 12000);
        this.events = events; setConnectionLostTimeout(0); setTcpNoDelay(true);
    }
    private static String checked(String ticket) { if (!RealtimePolicy.ticket(ticket)) throw new IllegalArgumentException("Invalid ticket"); return ticket; }
    @Override protected void onSetSSLParameters(SSLParameters parameters) { parameters.setEndpointIdentificationAlgorithm("HTTPS"); }
    void terminate() {
        stopped = true;
        // Also interrupt a TLS handshake which has not started the library's writer thread yet.
        try { if (getSocket() != null) getSocket().close(); } catch (Exception ignored) {}
        closeConnection(1000, "Client stopped");
    }
    @Override public void onOpen(ServerHandshake handshake) { if (stopped) terminate(); else events.opened(); }
    @Override public void onMessage(String message) { if (!stopped) events.message(message); }
    @Override public void onMessage(ByteBuffer message) { closeConnection(1002, "Unsupported message"); }
    @Override public void onClose(int code, String reason, boolean remote) { events.closed(code); }
    @Override public void onError(Exception ignored) { /* Library NOP provider also suppresses handshake diagnostics. */ }
}
