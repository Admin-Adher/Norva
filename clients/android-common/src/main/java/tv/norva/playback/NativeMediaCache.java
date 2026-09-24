package tv.norva.playback;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/** Per-player cache authority. Credentials never enter a URL, disk or provider request. */
public final class NativeMediaCache implements DataSource.Factory {
    private final DataSource.Factory provider;
    private volatile Access access;
    private volatile boolean configured;
    private volatile boolean closed;
    private boolean refreshing;
    private long generation;
    private String sessionId;

    public NativeMediaCache(DataSource.Factory provider) { this.provider = provider; }

    public synchronized void configure(String json, String url, String session) {
        generation++;
        configured = json != null && !json.isEmpty() && !"null".equals(json);
        access = null;
        sessionId = session;
        closed = false;
        if (configured) {
            try { access = new Access(new JSONObject(json), url); }
            catch (Exception ignored) { /* Fail closed in open(), then use the ordinary recovery. */ }
        }
    }

    public boolean active() { return configured && !closed; }
    public synchronized void close() { closed = true; generation++; access = null; sessionId = null; }

    /** Called with the fresh credential from the existing nonce-bound heartbeat bridge. */
    public synchronized void renewIfDue(String bearer) {
        final Access before = access;
        final String session = sessionId;
        if (closed || before == null || refreshing || System.currentTimeMillis() < before.refreshAt
                || bearer == null || bearer.length() > 16384 || bearer.indexOf('\n') >= 0
                || bearer.indexOf('\r') >= 0 || session == null
                || !session.matches("[0-9a-fA-F-]{36}")) return;
        final long epoch = generation;
        refreshing = true;
        Thread worker = new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL("https://api.norva.tv/functions/v1/"
                        + "norva-playback/playback/sessions/" + session + "/media-cache-ticket").openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(8000);
                connection.setReadTimeout(8000);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + bearer);
                connection.setRequestProperty("Content-Type", "application/json");
                byte[] body = new JSONObject().put("protocol", 1).put("objectKey", before.objectKey).toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(body.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
                if (connection.getResponseCode() != 200) return;
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[2048];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (output.size() + count > 16384) throw new IOException("Cache response too large");
                        output.write(buffer, 0, count);
                    }
                }
                JSONObject response = new JSONObject(output.toString("UTF-8"));
                if (response.optJSONObject("data") != null) response = response.getJSONObject("data");
                Access next = new Access(response, before.playlist);
                synchronized (NativeMediaCache.this) {
                    if (!closed && generation == epoch && access == before) access = next;
                }
            } catch (Exception ignored) {
                // Retry on the next heartbeat while the current ticket remains valid.
                // An expired ticket fails closed and invokes the single provider fallback.
            } finally {
                if (connection != null) connection.disconnect();
                synchronized (NativeMediaCache.this) { refreshing = false; }
            }
        }, "norva-cache-ticket");
        worker.setDaemon(true);
        worker.start();
    }

    static final class Access {
        final String objectKey, playlist, token;
        final URI root;
        final long expiresAt, refreshAt;
        Access(JSONObject value, String expectedUrl) throws Exception {
            objectKey = value.getString("objectKey");
            playlist = value.getString("playlistUrl");
            JSONObject authorization = value.getJSONObject("authorization");
            token = authorization.getString("token");
            root = new URI(playlist);
            expiresAt = date(value.getString("ticketExpiresAt"));
            refreshAt = date(value.getString("refreshAfter"));
            if (value.getInt("protocol") != 1 || !"private-r2-hls".equals(value.getString("transport"))
                    || !objectKey.matches("[0-9a-f]{64}") || !playlist.equals(expectedUrl)
                    || !"Bearer".equals(authorization.getString("scheme"))
                    || !token.matches("mc1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+") || token.length() > 4096
                    || refreshAt >= expiresAt || expiresAt > date(value.getString("hardExpiresAt"))
                    || !allows(playlist)) throw new IOException("Invalid cache authority");
        }
        boolean allows(String url) {
            try {
                URI candidate = new URI(url);
                return "https".equals(candidate.getScheme()) && candidate.getHost() != null
                        && candidate.getHost().equals(root.getHost()) && candidate.getPort() == root.getPort()
                        && candidate.getUserInfo() == null && candidate.getRawQuery() == null
                        && candidate.getRawFragment() == null && candidate.getRawPath().indexOf('%') < 0
                        && candidate.normalize().equals(candidate)
                        && candidate.getPath().startsWith("/v1/hls/" + objectKey + "/");
            } catch (Exception ignored) { return false; }
        }
        private static long date(String value) throws Exception {
            java.util.regex.Matcher parts = java.util.regex.Pattern.compile(
                    "^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})$").matcher(value);
            if (!parts.matches()) throw new IOException("Invalid cache date");
            String fraction = ((parts.group(2) == null ? "" : parts.group(2)) + "000").substring(0, 3);
            String zone = "Z".equals(parts.group(3)) ? "+0000" : parts.group(3).replace(":", "");
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.US);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            format.setLenient(false);
            return format.parse(parts.group(1) + "." + fraction + zone).getTime();
        }
    }

    @Override public DataSource createDataSource() {
        return new DataSource() {
            final List<TransferListener> listeners = new ArrayList<>();
            DataSource delegate;
            @Override public void addTransferListener(TransferListener listener) { listeners.add(listener); }
            @Override public long open(DataSpec spec) throws IOException {
                if (closed) throw new IOException("Playback closed");
                delegate = configured ? new CacheSource() : provider.createDataSource();
                for (TransferListener listener : listeners) delegate.addTransferListener(listener);
                return delegate.open(spec);
            }
            @Override public int read(byte[] bytes, int offset, int length) throws IOException { return delegate.read(bytes, offset, length); }
            @Override public Uri getUri() { return delegate == null ? null : delegate.getUri(); }
            @Override public java.util.Map<String, List<String>> getResponseHeaders() {
                return delegate == null ? java.util.Collections.emptyMap() : delegate.getResponseHeaders();
            }
            @Override public void close() throws IOException { if (delegate != null) delegate.close(); delegate = null; }
        };
    }

    private final class CacheSource extends BaseDataSource {
        HttpURLConnection connection;
        InputStream input;
        Uri uri;
        long remaining;
        long received;
        boolean opened;
        CacheSource() { super(true); }
        @Override public long open(DataSpec spec) throws IOException {
            Access current = access;
            if (closed || current == null || !current.allows(spec.uri.toString())
                    || System.currentTimeMillis() >= current.expiresAt || spec.httpMethod != DataSpec.HTTP_METHOD_GET) {
                throw new IOException("Cache authorization unavailable");
            }
            transferInitializing(spec);
            uri = spec.uri;
            try {
                connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
                // Reject every redirect, including same-protocol redirects. No ticket can escape its prefix.
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setRequestProperty("Accept-Encoding", "identity");
                connection.setRequestProperty("Authorization", "Bearer " + current.token);
                if (spec.position != 0 || spec.length != C.LENGTH_UNSET) {
                    connection.setRequestProperty("Range", "bytes=" + spec.position + "-"
                            + (spec.length == C.LENGTH_UNSET ? "" : Long.toString(spec.position + spec.length - 1)));
                }
                int status = connection.getResponseCode();
                if ((status != 200 && status != 206) || (spec.position > 0 && status != 206)) throw new IOException("Cache request failed");
                long length = -1;
                try { length = Long.parseLong(connection.getHeaderField("Content-Length")); }
                catch (NumberFormatException ignored) { /* chunked response */ }
                if (length > 256L * 1024 * 1024) throw new IOException("Cache response too large");
                remaining = spec.length != C.LENGTH_UNSET ? spec.length : length;
                input = connection.getInputStream();
                opened = true;
                transferStarted(spec);
                return remaining;
            } catch (IOException error) { close(); throw new IOException("Secure cache unavailable"); }
        }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining == 0) return C.RESULT_END_OF_INPUT;
            int count = input.read(bytes, offset, remaining < 0 ? length : (int)Math.min(length, remaining));
            if (count < 0) return C.RESULT_END_OF_INPUT;
            received += count;
            if (received > 256L * 1024 * 1024) throw new IOException("Cache response too large");
            if (remaining > 0) remaining -= count;
            bytesTransferred(count);
            return count;
        }
        @Override public Uri getUri() { return uri; }
        @Override public void close() throws IOException {
            try { if (input != null) input.close(); }
            finally {
                input = null;
                if (connection != null) connection.disconnect();
                connection = null;
                if (opened) { opened = false; transferEnded(); }
            }
        }
    }
}
