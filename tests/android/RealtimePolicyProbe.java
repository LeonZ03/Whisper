package org.leonz.whisper;

import java.nio.ByteBuffer;
import javax.net.ssl.SSLParameters;
import org.java_websocket.enums.Role;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.handshake.HandshakeImpl1Client;
import org.slf4j.LoggerFactory;
import org.slf4j.helpers.NOPLoggerFactory;

/** Host JVM, local protocol checks. Does not claim Android service/Doze validation. */
public final class RealtimePolicyProbe {
    public static void main(String[] args) throws Exception {
        System.setProperty("slf4j.provider", "org.slf4j.nop.NOPServiceProvider");
        System.setProperty("slf4j.internal.verbosity", "ERROR");
        if (!(LoggerFactory.getILoggerFactory() instanceof NOPLoggerFactory)) throw new AssertionError("Handshake logging enabled");
        String id = "11111111-1111-4111-8111-111111111111", key = new String(new char[43]).replace('\0', 'A') + "=";
        if (!RealtimePolicy.identity(id, key) || RealtimePolicy.identity(id, "bad")) throw new AssertionError("Identity validation");
        for (int failures = 0; failures < 100; failures++) for (double random : new double[]{0, .5, 1}) {
            long delay = RealtimePolicy.retryDelay(failures, random);
            if (delay < 1000 || delay > 60000) throw new AssertionError("Unbounded reconnect");
        }
        if (RealtimePolicy.HEARTBEAT != 45000 || RealtimePolicy.PONG_TIMEOUT != 15000 || RealtimePolicy.VALIDATION != 90000) throw new AssertionError("Unexpected cadence");
        String ticket = new String(new char[43]).replace('\0', 'A');
        HintSocket socket = new HintSocket(ticket, new HintSocket.Events() {
            public void opened() {} public void message(String value) {} public void closed(int code) {}
        });
        if (!"wss://whisper.leonz03.dpdns.org/api/realtime".equals(socket.getURI().toString()) || socket.getURI().getQuery() != null) throw new AssertionError("Credential in URL or wrong origin");
        SSLParameters ssl = new SSLParameters(); socket.onSetSSLParameters(ssl);
        if (!"HTTPS".equals(ssl.getEndpointIdentificationAlgorithm())) throw new AssertionError("Hostname verification disabled");
        HandshakeImpl1Client request = new HandshakeImpl1Client(); request.setResourceDescriptor("/api/realtime");
        socket.getDraft().postProcessHandshakeRequestAsClient(request);
        String protocols = request.getFieldValue("Sec-WebSocket-Protocol");
        if (!protocols.contains("whisper-realtime-v1") || !protocols.contains("ticket." + ticket) || request.hasFieldValue("Cookie")) throw new AssertionError("Invalid ticket handshake");
        socket.getDraft().setParseMode(Role.CLIENT);
        // An oversized server frame must be rejected before allocating its advertised payload.
        byte[] header = {(byte) 0x81, 126, 8, 0};
        try { socket.getDraft().translateFrame(ByteBuffer.wrap(header)); throw new AssertionError("Oversized frame accepted"); }
        catch (InvalidDataException expected) {}
        try { new HintSocket("bad", null); throw new AssertionError("Invalid ticket accepted"); } catch (IllegalArgumentException expected) {}
        System.out.println("Native reconnect bounds, fixed-origin TLS policy, bounded WebSocket frames and NOP logging: passed (host JVM).");
    }
}
