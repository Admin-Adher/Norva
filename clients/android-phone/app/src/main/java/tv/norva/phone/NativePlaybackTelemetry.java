package tv.norva.phone;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** Authenticated, best-effort native playback truth. Never blocks playback. */
final class NativePlaybackTelemetry {
    private static final String EVENTS_URL =
            "https://api.norva.tv/functions/v1/norva-playback/playback/events";
    private static final String PLAYBACK_SESSIONS_URL =
            "https://api.norva.tv/functions/v1/norva-playback/playback/sessions/";
    private static final int MAX_AUTH_TOKEN_CHARS = 16_384;
    private static final int MAX_RESPONSE_BYTES = 1_024;
    private static final Pattern UUID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);

    private NativePlaybackTelemetry() {
    }

    static String boundedSessionId(String value) {
        if (value == null || value.length() != 36 || !UUID.matcher(value).matches()) return null;
        return value.toLowerCase(Locale.ROOT);
    }

    static String boundedRecoveryReason(String value) {
        if (value == null) return "none";
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        if (normalized.length() > 96) return "other";
        switch (normalized) {
            case "no_data_timeout":
            case "premature_eof":
            case "live_eof":
            case "manual_retry":
            case "playback_interrupted":
            case "fresh_stream_timeout":
            case "resolve_failed":
            case "none":
                return normalized;
            default:
                if (normalized.startsWith("error_code_io_network")
                        || normalized.startsWith("error_code_io_unspecified")) {
                    return "io_network";
                }
                if (normalized.startsWith("error_code_io_bad_http_status")) return "http_status";
                if (normalized.contains("parsing_container")
                        || normalized.contains("parsing_manifest")) return "parsing";
                if (normalized.contains("decoder") || normalized.contains("decoding")) {
                    return "decoder";
                }
                return "other";
        }
    }

    static String boundedRecoveryRoute(String value) {
        if ("direct".equals(value) || "gateway".equals(value) || "fresh".equals(value)) {
            return value;
        }
        return "unknown";
    }

    static String boundedTerminalCode(String value) {
        if ("native_format".equals(value)
                || "native_offline".equals(value)
                || "native_reconnect_failed".equals(value)
                || "native_terminal".equals(value)) {
            return value;
        }
        return "native_terminal";
    }

    static void recordFirstFrame(final String authToken, final String playbackSessionId,
                                 final String sourceId, final String itemType,
                                 final String itemId, final long timeToFirstFrameMs,
                                 final boolean offline) {
        if (offline || !validAuthToken(authToken)
                || !validItemIdentity(itemType, itemId)) return;
        final String boundedSessionId = boundedSessionId(playbackSessionId);
        startWorker("norva-first-frame", new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject body = baseEvent(
                            "first_frame", boundedSessionId, sourceId, itemType, itemId);
                    body.put("timeToFirstFrameMs", Math.max(1L,
                            Math.min(600_000L, timeToFirstFrameMs)));
                    JSONObject metadata = new JSONObject();
                    metadata.put("clientSurface", "android-phone");
                    metadata.put("nativeRenderedFrame", true);
                    body.put("metadata", metadata);
                    postJson(EVENTS_URL, authToken, body);
                } catch (Throwable ignored) {
                    // Playback truth is best-effort; playback always wins.
                }
            }
        });
    }

    static void recordHeartbeat(final String authToken, final String playbackSessionId) {
        final String boundedSessionId = boundedSessionId(playbackSessionId);
        if (!validAuthToken(authToken) || boundedSessionId == null) return;
        startWorker("norva-playback-heartbeat", new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                try {
                    connection = openConnection(
                            PLAYBACK_SESSIONS_URL + boundedSessionId + "/heartbeat",
                            authToken);
                    connection.setRequestMethod("POST");
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(0);
                    OutputStream out = connection.getOutputStream();
                    out.close();
                    consumeBoundedResponse(connection);
                } catch (Throwable ignored) {
                    // A missed lease pulse must never interrupt playback.
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        });
    }

    static void recordTerminal(final String authToken, final String playbackSessionId,
                               final String sourceId, final String itemType,
                               final String itemId, final String terminalCode,
                               final boolean sawLongStart, final String recoveryReason,
                               final String recoveryRoute, final int recoveryAttempt,
                               final boolean offline) {
        if (offline || !validAuthToken(authToken)
                || !validItemIdentity(itemType, itemId)) return;
        final String boundedSessionId = boundedSessionId(playbackSessionId);
        final String boundedTerminalCode = boundedTerminalCode(terminalCode);
        final String boundedRecoveryReason = boundedRecoveryReason(recoveryReason);
        final String boundedRecoveryRoute = boundedRecoveryRoute(recoveryRoute);
        final int boundedAttempt = Math.max(0, Math.min(3, recoveryAttempt));
        startWorker("norva-playback-terminal", new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject body = baseEvent(
                            "playback_error", boundedSessionId, sourceId, itemType, itemId);
                    body.put("errorCode", boundedTerminalCode);
                    JSONObject metadata = new JSONObject();
                    metadata.put("clientSurface", "android-phone");
                    metadata.put("sawLongStart", sawLongStart);
                    metadata.put("recoveryReason", boundedRecoveryReason);
                    metadata.put("recoveryRoute", boundedRecoveryRoute);
                    metadata.put("recoveryAttempt", boundedAttempt);
                    body.put("metadata", metadata);
                    postJson(EVENTS_URL, authToken, body);
                } catch (Throwable ignored) {
                    // Diagnostics are bounded, at-most-once and best-effort.
                }
            }
        });
    }

    private static JSONObject baseEvent(String eventType, String playbackSessionId,
                                        String sourceId, String itemType,
                                        String itemId) throws Exception {
        JSONObject body = new JSONObject();
        body.put("eventType", eventType);
        if (playbackSessionId != null) body.put("playbackSessionId", playbackSessionId);
        if (sourceId != null && UUID.matcher(sourceId).matches()) body.put("sourceId", sourceId);
        body.put("itemType", boundedItemValue(itemType));
        body.put("itemId", boundedItemValue(itemId));
        body.put("playbackMode", "native");
        return body;
    }

    private static boolean validItemIdentity(String itemType, String itemId) {
        return boundedItemValue(itemType) != null && boundedItemValue(itemId) != null;
    }

    private static String boundedItemValue(String value) {
        if (value == null || value.isEmpty() || value.length() > 256) return null;
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) return null;
        }
        return value;
    }

    private static boolean validAuthToken(String authToken) {
        if (authToken == null || authToken.isEmpty()
                || authToken.length() > MAX_AUTH_TOKEN_CHARS) return false;
        return authToken.indexOf('\r') < 0 && authToken.indexOf('\n') < 0;
    }

    private static void postJson(String url, String authToken, JSONObject body) throws Exception {
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection connection = null;
        try {
            connection = openConnection(url, authToken);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(payload.length);
            connection.setRequestProperty("Content-Type", "application/json");
            OutputStream out = connection.getOutputStream();
            out.write(payload);
            out.close();
            consumeBoundedResponse(connection);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static HttpURLConnection openConnection(String url, String authToken)
            throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + authToken);
        return connection;
    }

    private static void consumeBoundedResponse(HttpURLConnection connection) throws Exception {
        InputStream in = connection.getResponseCode() < 400
                ? connection.getInputStream() : connection.getErrorStream();
        if (in == null) return;
        try {
            byte[] sink = new byte[256];
            int remaining = MAX_RESPONSE_BYTES;
            while (remaining > 0) {
                int read = in.read(sink, 0, Math.min(sink.length, remaining));
                if (read < 0) break;
                remaining -= read;
            }
        } finally {
            in.close();
        }
    }

    private static void startWorker(String name, Runnable task) {
        Thread worker = new Thread(task, name);
        worker.start();
    }
}
