package tv.norva.phone;

import android.net.Uri;

import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Wraps an HTTP {@link DataSource} and turns OPEN-ENDED seek ranges into
 * BOUNDED ones.
 *
 * Some IPTV providers ignore an open-ended {@code Range: bytes=N-} request and
 * answer from byte 0. ExoPlayer then has to read-and-discard from the start on
 * every seek, which stalls Resume by ~20s on a deep offset. The same providers
 * DO honor a bounded {@code Range: bytes=N-M}, so once the total size is known
 * (learned from the initial full open) every later seek is bounded to
 * {@code [position, total-1]} and the player jumps straight to the resume point.
 *
 * Live/HLS is unaffected: manifests and segments are fetched whole (position 0)
 * or with an already-bounded byte range, so the rewrite never triggers.
 */
@UnstableApi
public final class BoundedRangeDataSource implements DataSource {

    /** Factory that wraps every DataSource produced by {@code upstreamFactory}. */
    public static final class Factory implements DataSource.Factory {
        private final DataSource.Factory upstreamFactory;

        public Factory(DataSource.Factory upstreamFactory) {
            this.upstreamFactory = upstreamFactory;
        }

        @Override
        public DataSource createDataSource() {
            return new BoundedRangeDataSource(upstreamFactory.createDataSource());
        }
    }

    private final DataSource upstream;
    private long totalLength = C.LENGTH_UNSET;
    private final byte[] prefix = new byte[256];
    private int prefixLength;
    private int prefixPosition;

    /** A provider returned a web page, not a video. Never retain its body or URL. */
    static final class HtmlResponseException extends IOException {
        HtmlResponseException() { super("Provider returned an HTML document"); }
    }

    static boolean isHtmlResponse(Throwable error) {
        for (int depth = 0; error != null && depth < 8; depth++, error = error.getCause()) {
            if (error instanceof HtmlResponseException) return true;
        }
        return false;
    }

    static boolean isHtmlDocument(byte[] bytes, int length) {
        String start = new String(bytes, 0, length, StandardCharsets.UTF_8)
                .replace("\uFEFF", "").trim().toLowerCase(Locale.ROOT);
        return start.startsWith("<!doctype html") || start.matches("(?s)^<html(?:\\s|>).*")
                || (start.startsWith("<?xml") && start.matches("(?s).*<html(?:\\s|>).*"));
    }

    private BoundedRangeDataSource(DataSource upstream) {
        this.upstream = upstream;
    }

    @Override
    public long open(DataSpec dataSpec) throws IOException {
        prefixLength = prefixPosition = 0;
        DataSpec effective = dataSpec;
        // An open-ended seek past the start: bound it to the end of the file so
        // the provider honors the Range (206 from `position`) instead of
        // replaying from byte 0. subrange(0, len) keeps the position.
        if (dataSpec.length == C.LENGTH_UNSET
                && dataSpec.position > 0
                && totalLength != C.LENGTH_UNSET
                && dataSpec.position < totalLength) {
            effective = dataSpec.subrange(0, totalLength - dataSpec.position);
        }
        long opened = upstream.open(effective);
        // Some providers answer a movie request with an HTML refusal on HTTP
        // 200/206. Confirm the body before rejecting it: mislabeled playable
        // bytes must still reach Media3. Ordinary media requests incur no peek.
        boolean htmlContentType = false;
        for (Map.Entry<String, List<String>> header : upstream.getResponseHeaders().entrySet()) {
            if (!"content-type".equalsIgnoreCase(header.getKey()) || header.getValue() == null) continue;
            for (String value : header.getValue()) {
                if (value == null) continue;
                String type = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
                htmlContentType |= "text/html".equals(type) || "application/xhtml+xml".equals(type);
            }
        }
        if (htmlContentType) {
            try {
                int limit = opened == C.LENGTH_UNSET ? prefix.length : (int) Math.min(opened, prefix.length);
                while (prefixLength < limit) {
                    int read = upstream.read(prefix, prefixLength, limit - prefixLength);
                    if (read == C.RESULT_END_OF_INPUT || read == 0) break;
                    prefixLength += read;
                    if (isHtmlDocument(prefix, prefixLength)) throw new HtmlResponseException();
                }
            } catch (IOException error) {
                try { upstream.close(); } catch (IOException ignored) { }
                prefixLength = prefixPosition = 0;
                throw error;
            }
        }
        // Remember the total size learned from the initial full (position 0)
        // open so later seeks can be bounded.
        if (totalLength == C.LENGTH_UNSET && effective.position == 0 && opened != C.LENGTH_UNSET) {
            totalLength = opened;
        }
        return opened;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        if (prefixPosition < prefixLength) {
            int read = Math.min(length, prefixLength - prefixPosition);
            System.arraycopy(prefix, prefixPosition, buffer, offset, read);
            prefixPosition += read;
            return read;
        }
        return upstream.read(buffer, offset, length);
    }

    @Override
    public void addTransferListener(TransferListener transferListener) {
        upstream.addTransferListener(transferListener);
    }

    @Override
    public Uri getUri() {
        return upstream.getUri();
    }

    @Override
    public Map<String, List<String>> getResponseHeaders() {
        return upstream.getResponseHeaders();
    }

    @Override
    public void close() throws IOException {
        prefixLength = prefixPosition = 0;
        upstream.close();
    }
}
