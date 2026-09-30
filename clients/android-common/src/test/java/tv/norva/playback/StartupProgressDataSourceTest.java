package tv.norva.playback;

import static org.junit.Assert.*;
import android.net.Uri;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

@androidx.media3.common.util.UnstableApi
public final class StartupProgressDataSourceTest {
    @Test public void cancellationClosesBlockedReadAndCannotReopenTheRoute() throws Exception {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        CountDownLatch reading = new CountDownLatch(1), closed = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        DataSource delegate = new StubSource() {
            @Override public int read(byte[] bytes, int offset, int length) throws IOException {
                reading.countDown();
                await(closed);
                return -1;
            }
            @Override public void close() { closes.incrementAndGet(); closed.countDown(); }
        };
        StartupProgressDataSource source = new StartupProgressDataSource(delegate, progress, progress.begin(0));
        source.open(null);
        AtomicReference<Throwable> result = new AtomicReference<>();
        Thread loader = new Thread(() -> {
            try { source.read(new byte[1], 0, 1); }
            catch (Throwable error) { result.set(error); }
        });
        loader.start();
        assertTrue(reading.await(2, TimeUnit.SECONDS));
        progress.stop();
        assertTrue(closed.await(2, TimeUnit.SECONDS));
        loader.join(2000);
        assertFalse(loader.isAlive());
        assertTrue(result.get() instanceof IOException);
        source.close();
        assertEquals(1, closes.get());
        try { source.open(null); fail("Cancelled reader reopened"); }
        catch (IOException expected) { }
    }

    @Test public void cancellationDuringOpenAlsoClosesALatePublishedConnection() throws Exception {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        CountDownLatch opening = new CountDownLatch(1), finishOpen = new CountDownLatch(1), firstClose = new CountDownLatch(1);
        AtomicInteger closes = new AtomicInteger();
        DataSource delegate = new StubSource() {
            @Override public long open(DataSpec spec) throws IOException {
                opening.countDown(); await(finishOpen); return 1;
            }
            @Override public void close() { closes.incrementAndGet(); firstClose.countDown(); }
        };
        StartupProgressDataSource source = new StartupProgressDataSource(delegate, progress, progress.begin(0));
        AtomicReference<Throwable> result = new AtomicReference<>();
        Thread loader = new Thread(() -> {
            try { source.open(null); }
            catch (Throwable error) { result.set(error); }
        });
        loader.start();
        assertTrue(opening.await(2, TimeUnit.SECONDS));
        progress.stop();
        assertTrue(firstClose.await(2, TimeUnit.SECONDS));
        finishOpen.countDown();
        loader.join(2000);
        assertFalse(loader.isAlive());
        assertTrue(result.get() instanceof IOException);
        assertEquals(2, closes.get());
    }

    @Test public void firstFrameDoesNotCloseTheReaderOrPreventSameRouteSeeks() throws Exception {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        AtomicInteger closes = new AtomicInteger();
        DataSource delegate = new StubSource() {
            @Override public void close() { closes.incrementAndGet(); }
        };
        StartupProgressDataSource source = new StartupProgressDataSource(delegate, progress, progress.begin(0));
        source.open(null);
        progress.rendered();
        assertEquals(0, closes.get());
        source.close();
        source.open(null);
        progress.stop();
        // Await the dispatched close independently of the previous seek close.
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (closes.get() < 2 && System.nanoTime() < deadline) Thread.sleep(1);
        assertEquals(2, closes.get());
    }

    @Test public void aReaderCloseRaceCannotCrashTheCancellationWorker() throws Exception {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        CountDownLatch closing = new CountDownLatch(1);
        AtomicReference<Thread> worker = new AtomicReference<>();
        AtomicReference<Throwable> escaped = new AtomicReference<>();
        DataSource delegate = new StubSource() {
            @Override public void close() {
                Thread current = Thread.currentThread();
                current.setUncaughtExceptionHandler((thread, error) -> escaped.set(error));
                worker.set(current);
                closing.countDown();
                throw new IllegalStateException("Fixture close race");
            }
        };
        StartupProgressDataSource source = new StartupProgressDataSource(delegate, progress, progress.begin(0));
        source.open(null);
        progress.stop();
        assertTrue(closing.await(2, TimeUnit.SECONDS));
        worker.get().join(2000);
        assertFalse(worker.get().isAlive());
        assertNull(escaped.get());
    }

    private static void await(CountDownLatch latch) throws IOException {
        try { if (!latch.await(2, TimeUnit.SECONDS)) throw new IOException("Fixture timed out"); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new IOException(error); }
    }

    private static class StubSource implements DataSource {
        @Override public long open(DataSpec spec) throws IOException { return 1; }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException { return -1; }
        @Override public Uri getUri() { return null; }
        @Override public void addTransferListener(TransferListener listener) { }
        @Override public void close() throws IOException { }
    }
}
