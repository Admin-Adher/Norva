package tv.nodecast.client;

import android.net.Uri;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.util.List;
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

    private BoundedRangeDataSource(DataSource upstream) {
        this.upstream = upstream;
    }

    @Override
    public long open(DataSpec dataSpec) throws IOException {
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
        // Remember the total size learned from the initial full (position 0)
        // open so later seeks can be bounded.
        if (totalLength == C.LENGTH_UNSET && effective.position == 0 && opened != C.LENGTH_UNSET) {
            totalLength = opened;
        }
        return opened;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        return upstream.read(buffer, offset, length);
    }

    @Override
    public void addTransferListener(TransferListener transferListener) {
        upstream.addTransferListener(transferListener);
    }

    @Nullable
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
        upstream.close();
    }
}
