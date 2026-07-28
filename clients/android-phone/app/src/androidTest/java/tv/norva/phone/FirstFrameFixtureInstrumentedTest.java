package tv.norva.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;

import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Release gate for the first visible frame. This uses the repository's real
 * Matroska H.264/AAC fixture and accepts success only from Media3's
 * onRenderedFirstFrame callback with the actually selected MIME types.
 */
@RunWith(AndroidJUnit4.class)
public final class FirstFrameFixtureInstrumentedTest {

    @Test
    public void h264AacFixtureRendersARealFirstFrame() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        Context testContext = instrumentation.getContext();
        File fixture = new File(target.getCacheDir(), "norva-first-frame-h264-aac.mkv");
        copyFixture(testContext, fixture);

        String token = UUID.randomUUID().toString();
        CountDownLatch resultLatch = new CountDownLatch(1);
        AtomicReference<Intent> resultRef = new AtomicReference<>();
        AtomicReference<Activity> activityRef = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor =
                instrumentation.addMonitor(PlayerActivity.class.getName(), null, false);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!token.equals(intent.getStringExtra(
                        PlayerActivity.EXTRA_FIRST_FRAME_TEST_TOKEN))) return;
                resultRef.set(intent);
                resultLatch.countDown();
            }
        };

        ContextCompat.registerReceiver(
                target,
                receiver,
                new IntentFilter(PlayerActivity.ACTION_FIRST_FRAME_TEST_RESULT),
                ContextCompat.RECEIVER_NOT_EXPORTED);
        try (FixtureHttpServer server = new FixtureHttpServer(
                Files.readAllBytes(fixture.toPath()))) {
            Intent launch = new Intent(target, PlayerActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    // Exercise the real VOD path: DefaultHttpDataSource,
                    // BoundedRangeDataSource, extractor, decoder and renderer.
                    .putExtra(PlayerActivity.EXTRA_URL, server.url())
                    .putExtra(PlayerActivity.EXTRA_TITLE, "Norva first-frame gate")
                    .putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "movie")
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, "fixture-h264-aac")
                    .putExtra(PlayerActivity.EXTRA_CONTAINER, "mkv")
                    .putExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_TOKEN, token);
            target.startActivity(launch);
            activityRef.set(instrumentation.waitForMonitorWithTimeout(monitor, 5_000));

            assertTrue(
                    "Media3 did not render the deterministic H.264/AAC fixture in 15 seconds",
                    resultLatch.await(15, TimeUnit.SECONDS));
            Intent result = resultRef.get();
            assertNotNull(result);
            assertEquals(
                    "first_frame",
                    result.getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_OUTCOME));
            assertEquals(
                    PlayerActivity.FIRST_FRAME_FIXTURE_VIDEO_MIME,
                    result.getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_VIDEO_MIME));
            assertEquals(
                    PlayerActivity.FIRST_FRAME_FIXTURE_AUDIO_MIME,
                    result.getStringExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_AUDIO_MIME));
            assertTrue(result.getBooleanExtra(
                    PlayerActivity.EXTRA_FIRST_FRAME_TEST_CONTRACT_OK, false));
        } finally {
            try {
                Activity activity = activityRef.get();
                if (activity != null) instrumentation.runOnMainSync(activity::finish);
            } catch (Throwable ignored) {
                // The short fixture may already have closed the Activity.
            }
            instrumentation.removeMonitor(monitor);
            try { target.unregisterReceiver(receiver); } catch (Exception ignored) { }
            //noinspection ResultOfMethodCallIgnored
            fixture.delete();
        }
    }

    private static void copyFixture(Context testContext, File destination) throws Exception {
        try (InputStream input = testContext.getAssets().open("s_h264_aac.mkv");
             FileOutputStream output = new FileOutputStream(destination, false)) {
            byte[] buffer = new byte[32 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.getFD().sync();
        }
    }

    /**
     * Hermetic loopback origin with byte-range support. A file:// fixture would
     * bypass Norva's production HTTP data-source path (and is intentionally not
     * supported by BoundedRangeDataSource), so this server keeps the gate both
     * deterministic and representative.
     */
    private static final class FixtureHttpServer implements AutoCloseable {
        private final byte[] media;
        private final ServerSocket server;
        private final Thread thread;
        private volatile boolean closed;

        FixtureHttpServer(byte[] media) throws Exception {
            this.media = media;
            this.server = new ServerSocket(
                    0, 8, InetAddress.getByName("127.0.0.1"));
            this.thread = new Thread(this::serve, "norva-first-frame-origin");
            this.thread.setDaemon(true);
            this.thread.start();
        }

        String url() {
            return "http://127.0.0.1:" + server.getLocalPort()
                    + "/s_h264_aac.mkv";
        }

        private void serve() {
            while (!closed) {
                try {
                    Socket socket = server.accept();
                    handle(socket);
                } catch (Exception ignored) {
                    if (!closed) {
                        // The player test will time out with a useful assertion.
                    }
                }
            }
        }

        private void handle(Socket socket) {
            try (Socket client = socket;
                 InputStream input = client.getInputStream();
                 OutputStream output = client.getOutputStream()) {
                String request = readHeaders(input);
                boolean head = request.startsWith("HEAD ");
                long start = 0;
                long end = media.length - 1L;
                String range = headerValue(request, "Range");
                boolean partial = range != null && range.startsWith("bytes=");
                if (partial) {
                    String[] bounds = range.substring("bytes=".length())
                            .split("-", 2);
                    start = Long.parseLong(bounds[0]);
                    if (bounds.length > 1 && !bounds[1].isEmpty()) {
                        end = Math.min(end, Long.parseLong(bounds[1]));
                    }
                }
                if (start < 0 || start >= media.length || end < start) {
                    write(output, "HTTP/1.1 416 Range Not Satisfiable\r\n"
                            + "Content-Range: bytes */" + media.length + "\r\n"
                            + "Connection: close\r\n\r\n");
                    return;
                }
                int length = (int) (end - start + 1L);
                StringBuilder headers = new StringBuilder()
                        .append(partial
                                ? "HTTP/1.1 206 Partial Content\r\n"
                                : "HTTP/1.1 200 OK\r\n")
                        .append("Content-Type: video/x-matroska\r\n")
                        .append("Accept-Ranges: bytes\r\n")
                        .append("Content-Length: ").append(length).append("\r\n");
                if (partial) {
                    headers.append("Content-Range: bytes ")
                            .append(start).append('-').append(end).append('/')
                            .append(media.length).append("\r\n");
                }
                headers.append("Connection: close\r\n\r\n");
                write(output, headers.toString());
                if (!head) output.write(media, (int) start, length);
                output.flush();
            } catch (Exception ignored) {
                // Playback cancellation closes in-flight sockets during cleanup.
            }
        }

        private static String readHeaders(InputStream input) throws Exception {
            byte[] buffer = new byte[16 * 1024];
            int count = 0;
            int state = 0;
            while (count < buffer.length) {
                int value = input.read();
                if (value < 0) break;
                buffer[count++] = (byte) value;
                if ((state == 0 || state == 2) && value == '\r') state++;
                else if ((state == 1 || state == 3) && value == '\n') state++;
                else state = value == '\r' ? 1 : 0;
                if (state == 4) break;
            }
            return new String(buffer, 0, count, StandardCharsets.US_ASCII);
        }

        private static String headerValue(String request, String name) {
            String prefix = name + ":";
            for (String line : request.split("\r\n")) {
                if (line.regionMatches(true, 0, prefix, 0, prefix.length())) {
                    return line.substring(prefix.length()).trim();
                }
            }
            return null;
        }

        private static void write(OutputStream output, String value)
                throws Exception {
            output.write(value.getBytes(StandardCharsets.US_ASCII));
            output.flush();
        }

        @Override
        public void close() throws Exception {
            closed = true;
            server.close();
            thread.join(1_000);
        }
    }
}
