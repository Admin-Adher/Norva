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
    private final Object closeLock = new Object();
    private final Runnable cancellation = this::cancel;
    private volatile boolean cancelled;
    private boolean needsClose;

    public StartupProgressDataSource(DataSource delegate, NativeVodStartupProgress progress, long route) {
        this.delegate = delegate;
        this.progress = progress;
        this.route = route;
    }

    @Override public long open(DataSpec spec) throws IOException {
        if (!progress.attachReader(route, cancellation)) throw new IOException("Playback route closed");
        synchronized (closeLock) {
            if (cancelled) throw new IOException("Playback route closed");
            needsClose = true;
        }
        try {
            long length = delegate.open(spec);
            if (cancelled) throw new IOException("Playback route closed");
            return length;
        } catch (RuntimeException error) {
            if (cancelled) throw new IOException("Playback route closed", error);
            throw error;
        } finally {
            if (cancelled) {
                // Cancellation may race connect/open before it publishes its
                // socket. Close again once open has actually returned.
                synchronized (closeLock) { needsClose = true; }
                close();
            }
        }
    }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException {
        if (cancelled) throw new IOException("Playback route closed");
        int count;
        try { count = delegate.read(bytes, offset, length); }
        catch (RuntimeException error) {
            if (cancelled) throw new IOException("Playback route closed", error);
            throw error;
        }
        if (cancelled) throw new IOException("Playback route closed");
        progress.bytesRead(route, count, SystemClock.elapsedRealtime());
        return count;
    }
    @Override public Uri getUri() { return delegate.getUri(); }
    @Override public Map<String, List<String>> getResponseHeaders() { return delegate.getResponseHeaders(); }
    @Override public void addTransferListener(TransferListener listener) { delegate.addTransferListener(listener); }
    @Override public void close() throws IOException {
        progress.detachReader(cancellation);
        synchronized (closeLock) {
            if (!needsClose) return;
            needsClose = false;
            delegate.close();
        }
    }

    private void cancel() {
        synchronized (this) {
            if (cancelled) return;
            cancelled = true;
        }
        // Media3 stop() only sets a loader cancellation flag. A blocked HTTP
        // read must also be closed, without doing network I/O on the UI thread.
        Thread closer = new Thread(() -> {
            try { close(); }
            catch (IOException | RuntimeException ignored) {
                // Some readers clear their stream during open/close races.
                // Cancellation must not crash the process from this worker.
            }
        }, "norva-vod-reader-close");
        closer.setDaemon(true);
        closer.start();
    }
}
