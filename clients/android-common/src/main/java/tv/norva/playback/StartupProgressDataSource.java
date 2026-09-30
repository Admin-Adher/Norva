package tv.norva.playback;

import android.net.Uri;
import android.os.SystemClock;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Observes the existing media reader; never adds a probe, buffer, or connection. */
@UnstableApi
public final class StartupProgressDataSource implements DataSource {
    private final DataSource delegate;
    private final NativeVodStartupProgress progress;
    private final long route;

    public StartupProgressDataSource(DataSource delegate, NativeVodStartupProgress progress, long route) {
        this.delegate = delegate;
        this.progress = progress;
        this.route = route;
    }

    @Override public long open(DataSpec spec) throws IOException { return delegate.open(spec); }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
        int count = delegate.read(bytes, offset, length);
        progress.bytesRead(route, count, SystemClock.elapsedRealtime());
        return count;
    }
    @Override public Uri getUri() { return delegate.getUri(); }
    @Override public Map<String, List<String>> getResponseHeaders() { return delegate.getResponseHeaders(); }
    @Override public void addTransferListener(TransferListener listener) { delegate.addTransferListener(listener); }
    @Override public void close() throws IOException { delegate.close(); }
}
