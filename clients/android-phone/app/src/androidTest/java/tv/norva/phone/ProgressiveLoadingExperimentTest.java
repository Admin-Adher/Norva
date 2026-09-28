package tv.norva.phone;

import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Comparative experiment only; production buffering policy is unchanged. */
@UnstableApi
@RunWith(AndroidJUnit4.class)
public final class ProgressiveLoadingExperimentTest {
    @Test public void compareLoadingIntervalsAtControlledThroughput() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        for (String fixture : new String[]{"extensionless-hls.ts", "s_h264_aac.mkv"}) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = instrumentation.getContext().getAssets().open(fixture)) {
                byte[] buffer = new byte[16384]; int read;
                while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            }
            byte[] bytes = output.toByteArray();
            // Alternate order to avoid systematically favoring warm decoder startup.
            for (int repetition = 0; repetition < 2; repetition++) {
                for (int interval : repetition == 0 ? new int[]{1048576, 131072} : new int[]{131072, 1048576}) {
                    run(instrumentation, bytes, fixture, interval, repetition == 0 ? 0 : 3000);
                }
            }
        }
    }

    private void run(Instrumentation instrumentation, byte[] bytes, String fixture,
            int interval, long resumeMs) throws Exception {
        CountDownLatch ready = new CountDownLatch(1);
        AtomicReference<PlaybackException> failure = new AtomicReference<>();
        AtomicReference<ExoPlayer> reference = new AtomicReference<>();
        long[] measured = new long[3];
        long started = SystemClock.elapsedRealtime();
        try {
            instrumentation.runOnMainSync(() -> {
                ExoPlayer player = new ExoPlayer.Builder(instrumentation.getTargetContext()).build();
                reference.set(player);
                player.addListener(new Player.Listener() {
                    @Override public void onPlaybackStateChanged(int state) {
                        if (state == Player.STATE_READY && ready.getCount() != 0) {
                            measured[0] = SystemClock.elapsedRealtime() - started;
                            measured[1] = player.getCurrentPosition();
                            measured[2] = player.getBufferedPosition();
                            ready.countDown();
                        }
                    }
                    @Override public void onPlayerError(PlaybackException error) {
                        failure.set(error); ready.countDown();
                    }
                });
                ProgressiveMediaSource source = new ProgressiveMediaSource.Factory(() -> new ThrottledBytes(bytes))
                        .setContinueLoadingCheckIntervalBytes(interval)
                        .createMediaSource(MediaItem.fromUri("https://fixture.invalid/" + fixture));
                player.setMediaSource(source, resumeMs);
                player.prepare();
                player.play();
            });
            assertTrue("Timed out: " + fixture + " interval=" + interval, ready.await(40, TimeUnit.SECONDS));
            assertNull("Fixture playback failed", failure.get());
            assertTrue("Requested resume position preserved", Math.abs(measured[1] - resumeMs) < 500);
            Log.i("NorvaLoadingExperiment", "fixture=" + fixture + " interval=" + interval
                    + " resumeMs=" + resumeMs + " readyMs=" + measured[0]
                    + " positionMs=" + measured[1] + " bufferedMs=" + measured[2]);
        } finally {
            instrumentation.runOnMainSync(() -> { if (reference.get() != null) reference.get().release(); });
        }
    }

    // 4 KiB per 16 ms, at most 256 KiB/s. Every seek uses the same byte source.
    private static final class ThrottledBytes extends BaseDataSource {
        private final byte[] bytes;
        private int position;
        private int end;
        private Uri uri;
        ThrottledBytes(byte[] bytes) { super(true); this.bytes = bytes; }
        @Override public long open(DataSpec spec) {
            transferInitializing(spec);
            uri = spec.uri; position = (int) Math.min(spec.position, bytes.length);
            end = spec.length == C.LENGTH_UNSET ? bytes.length
                    : (int) Math.min(bytes.length, spec.position + spec.length);
            transferStarted(spec);
            return end - position;
        }
        @Override public int read(byte[] buffer, int offset, int length) {
            if (length == 0) return 0;
            if (position >= end) return C.RESULT_END_OF_INPUT;
            int read = Math.min(4096, Math.min(length, end - position));
            SystemClock.sleep(16);
            System.arraycopy(bytes, position, buffer, offset, read);
            position += read; bytesTransferred(read); return read;
        }
        @Override public Uri getUri() { return uri; }
        @Override public void close() { if (uri != null) { uri = null; transferEnded(); } }
    }
}
