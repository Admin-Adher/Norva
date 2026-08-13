package tv.norva.tv;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** Authenticated native playback truth and account-session liveness. */
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

    interface HeartbeatCallback {
        void onResult(String resultCode);
    }

    private NativePlaybackTelemetry() {
    }

    static String boundedSessionId(String value) {
        if (value == null || value.length() != 36 || !UUID.matcher(value).matches()) return null;
        return value.toLowerCase(Locale.ROOT);
    }

    static void recordFirstFrame(final String authToken, final String sourceId,
                                 final String itemType, final String itemId,
                                 final long timeToFirstFrameMs) {
        recordFirstFrame(authToken, null, sourceId, itemType, itemId, timeToFirstFrameMs);
    }

    static void recordFirstFrame(final String authToken, final String playbackSessionId,
                                 final String sourceId, final String itemType,
                                 final String itemId, final long timeToFirstFrameMs) {
        if (!validAuthToken(authToken)
                || itemType == null || itemType.isEmpty()
                || itemId == null || itemId.isEmpty()) return;
        final String boundedSessionId = boundedSessionId(playbackSessionId);
        startWorker("norva-first-frame", new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject body = new JSONObject();
                    body.put("eventType", "first_frame");
                    if (boundedSessionId != null) body.put("playbackSessionId", boundedSessionId);
                    if (sourceId != null && UUID.matcher(sourceId).matches()) {
                        body.put("sourceId", sourceId);
                    }
                    body.put("itemType", itemType);
                    body.put("itemId", itemId);
                    body.put("timeToFirstFrameMs", Math.max(1L,
                            Math.min(600_000L, timeToFirstFrameMs)));
                    body.put("playbackMode", "native");
                    JSONObject metadata = new JSONObject();
                    metadata.put("clientSurface", "android-tv");
                    metadata.put("nativeRenderedFrame", true);
                    body.put("metadata", metadata);
                    postJson(EVENTS_URL, authToken, body);
                } catch (Throwable ignored) {
                    // Measurement must never affect playback.
                }
            }
        });
    }

    static void recordHeartbeat(final String authToken, final String playbackSessionId,
                                final HeartbeatCallback callback) {
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
                    connection.getOutputStream().close();
                    int status = connection.getResponseCode();
                    String response = readBoundedResponse(connection);
                    String result = status >= 200 && status < 300
                            ? "ok"
                            : (status == 409 && response.contains(
                                    ProviderPlaybackPolicy.PLAYBACK_SUPERSEDED)
                                    ? ProviderPlaybackPolicy.PLAYBACK_SUPERSEDED
                                    : "HTTP_" + status);
                    if (callback != null) callback.onResult(result);
                } catch (Throwable ignored) {
                    if (callback != null) callback.onResult("NETWORK_ERROR");
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        });
    }

    static void reportProviderBusy(final String authToken, final String playbackSessionId) {
        final String boundedSessionId = boundedSessionId(playbackSessionId);
        if (!validAuthToken(authToken) || boundedSessionId == null) return;
        startWorker("norva-provider-busy", new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject body = new JSONObject();
                    body.put("code", "PROVIDER_BUSY");
                    body.put("networkCause", "PROVIDER_BUSY");
                    body.put("upstreamStatus", ProviderPlaybackPolicy.HTTP_PROVIDER_BUSY);
                    postJson(
                            PLAYBACK_SESSIONS_URL + boundedSessionId + "/provider-failure",
                            authToken,
                            body);
                } catch (Throwable ignored) {
                    // The local terminal state is authoritative even if reporting fails.
                }
            }
        });
    }

    private static boolean validAuthToken(String authToken) {
        return authToken != null && !authToken.isEmpty()
                && authToken.length() <= MAX_AUTH_TOKEN_CHARS
                && authToken.indexOf('\r') < 0 && authToken.indexOf('\n') < 0;
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
            readBoundedResponse(connection);
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

    private static String readBoundedResponse(HttpURLConnection connection) throws Exception {
        InputStream in = connection.getResponseCode() < 400
                ? connection.getInputStream() : connection.getErrorStream();
        if (in == null) return "";
        try {
            byte[] buffer = new byte[256];
            int remaining = MAX_RESPONSE_BYTES;
            StringBuilder response = new StringBuilder();
            while (remaining > 0) {
                int read = in.read(buffer, 0, Math.min(buffer.length, remaining));
                if (read < 0) break;
                response.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
                remaining -= read;
            }
            return response.toString();
        } finally {
            in.close();
        }
    }

    private static void startWorker(String name, Runnable task) {
        new Thread(task, name).start();
    }
}
