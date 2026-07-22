package tv.norva.tv;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/** Authenticated, best-effort native playback truth. Never blocks playback. */
final class NativePlaybackTelemetry {
    private static final String EVENTS_URL =
            "https://api.norva.tv/functions/v1/norva-playback/playback/events";
    private static final Pattern UUID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);

    private NativePlaybackTelemetry() {
    }

    static void recordFirstFrame(final String authToken, final String sourceId,
                                 final String itemType, final String itemId,
                                 final long timeToFirstFrameMs) {
        if (authToken == null || authToken.isEmpty() || authToken.length() > 16_384
                || itemType == null || itemType.isEmpty()
                || itemId == null || itemId.isEmpty()) return;
        Thread worker = new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection connection = null;
                try {
                    JSONObject body = new JSONObject();
                    body.put("eventType", "first_frame");
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

                    byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                    connection = (HttpURLConnection) new URL(EVENTS_URL).openConnection();
                    connection.setRequestMethod("POST");
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(8_000);
                    connection.setReadTimeout(8_000);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(payload.length);
                    connection.setRequestProperty("Content-Type", "application/json");
                    connection.setRequestProperty("Accept", "application/json");
                    connection.setRequestProperty("Authorization", "Bearer " + authToken);
                    OutputStream out = connection.getOutputStream();
                    out.write(payload);
                    out.close();
                    InputStream in = connection.getResponseCode() < 400
                            ? connection.getInputStream() : connection.getErrorStream();
                    if (in != null) {
                        byte[] sink = new byte[512];
                        while (in.read(sink) != -1) { /* discard */ }
                        in.close();
                    }
                } catch (Throwable ignored) {
                    // Telemetry is at-most-once and best-effort; playback always wins.
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }
        }, "norva-first-frame");
        worker.start();
    }
}
