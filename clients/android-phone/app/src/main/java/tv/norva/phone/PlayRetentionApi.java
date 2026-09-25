package tv.norva.phone;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** No redirects, credentials in headers only, bounded response; fails closed. */
final class PlayRetentionApi {
    interface Callback { void result(JSONObject body); }
    static void request(String token, JSONObject payload, Callback callback) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            JSONObject result = null;
            try {
                if (token == null || token.isEmpty() || token.length() > 16384) throw new IllegalArgumentException();
                connection = (HttpURLConnection) new URL("https://api.norva.tv/functions/v1/norva-cloud/billing/play-retention").openConnection();
                connection.setConnectTimeout(6000);
                connection.setReadTimeout(6000);
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setRequestProperty("apikey", BuildConfig.SUPABASE_PUBLISHABLE_KEY);
                if (payload != null) {
                    connection.setRequestMethod("POST");
                    connection.setRequestProperty("Content-Type", "application/json");
                    connection.setDoOutput(true);
                    try (OutputStream out = connection.getOutputStream()) { out.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
                }
                if (connection.getResponseCode() != 200) throw new IllegalStateException();
                try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[2048]; int count;
                    while ((count = in.read(buffer)) != -1) {
                        if (out.size() + count > 32768) throw new IllegalStateException();
                        out.write(buffer, 0, count);
                    }
                    result = new JSONObject(out.toString("UTF-8"));
                }
            } catch (Exception ignored) { /* Never expose an HTTP body or token to UI/logs. */ }
            finally { if (connection != null) connection.disconnect(); }
            callback.result(result);
        }, "norva-play-retention").start();
    }
    private PlayRetentionApi() { }
}
