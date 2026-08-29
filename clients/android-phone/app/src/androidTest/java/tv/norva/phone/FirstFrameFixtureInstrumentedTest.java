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
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.ColorDrawable;
import android.os.SystemClock;
import android.view.View;
import android.view.DisplayCutout;
import android.view.WindowInsets;
import android.widget.ImageButton;

import androidx.core.content.ContextCompat;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
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
                    "Media3 did not render the deterministic H.264/AAC fixture in 45 seconds",
                    resultLatch.await(45, TimeUnit.SECONDS));
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

    @Test
    public void episodeControlsFillTheDisplayAndHandOffInsteadOfSeeking() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        Context testContext = instrumentation.getContext();
        File fixture = new File(target.getCacheDir(), "norva-player-ui-h264-aac.mkv");
        copyFixture(testContext, fixture);
        target.getSharedPreferences("norva_player_ui", Context.MODE_PRIVATE)
                .edit().clear().commit();

        String token = UUID.randomUUID().toString();
        CountDownLatch resultLatch = new CountDownLatch(1);
        AtomicReference<Activity> activityRef = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor =
                instrumentation.addMonitor(PlayerActivity.class.getName(), null, false);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (token.equals(intent.getStringExtra(
                        PlayerActivity.EXTRA_FIRST_FRAME_TEST_TOKEN))) {
                    resultLatch.countDown();
                }
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
                    .putExtra(PlayerActivity.EXTRA_URL, server.url())
                    .putExtra(PlayerActivity.EXTRA_TITLE, "Norva player UI gate")
                    .putExtra(PlayerActivity.EXTRA_SOURCE_ID, "fixture-source")
                    .putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "episode")
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, "s4e1")
                    .putExtra(PlayerActivity.EXTRA_CONTAINER, "mkv")
                    .putExtra(PlayerActivity.EXTRA_PREVIOUS_TITLE, "S3 E10 - Previous")
                    .putExtra(PlayerActivity.EXTRA_NEXT_TITLE, "S4 E2 - Next")
                    .putExtra(PlayerActivity.EXTRA_FIRST_FRAME_TEST_TOKEN, token);
            target.startActivity(launch);
            Activity activity = instrumentation.waitForMonitorWithTimeout(monitor, 15_000);
            activityRef.set(activity);
            assertNotNull(activity);
            assertTrue("fixture did not render", resultLatch.await(45, TimeUnit.SECONDS));

            AtomicReference<ImageButton> previousRef = new AtomicReference<>();
            AtomicReference<ImageButton> nextRef = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> {
                PlayerView playerView = activity.findViewById(R.id.norva_player_view);
                View root = activity.findViewById(R.id.norva_player_root);
                View videoSurface = playerView.getVideoSurfaceView();
                View controller = activity.findViewById(androidx.media3.ui.R.id.exo_controller);
                View centerControls = activity.findViewById(
                        androidx.media3.ui.R.id.exo_center_controls);
                View bottomBar = activity.findViewById(androidx.media3.ui.R.id.exo_bottom_bar);
                View progress = activity.findViewById(androidx.media3.ui.R.id.exo_progress);
                ImageButton previous = activity.findViewById(
                        R.id.norva_player_previous_episode_button);
                ImageButton next = activity.findViewById(
                        R.id.norva_player_next_episode_button);
                assertNotNull(playerView);
                assertNotNull(root);
                assertNotNull(videoSurface);
                assertNotNull(controller);
                assertNotNull(centerControls);
                assertNotNull(bottomBar);
                assertNotNull(progress);
                assertNotNull(previous);
                assertNotNull(next);
                if (playerView.getPlayer() != null) playerView.getPlayer().pause();
                playerView.showController();
                assertEquals(AspectRatioFrameLayout.RESIZE_MODE_ZOOM,
                        playerView.getResizeMode());
                assertEquals(root.getWidth(), playerView.getWidth());
                assertEquals(root.getHeight(), playerView.getHeight());
                Rect windowBounds = activity.getWindowManager()
                        .getCurrentWindowMetrics().getBounds();
                assertEquals(0, root.getLeft());
                assertEquals(0, root.getTop());
                assertEquals(windowBounds.width(), root.getWidth());
                assertEquals(windowBounds.height(), root.getHeight());
                assertEquals(0, playerView.getLeft());
                assertEquals(0, playerView.getTop());
                assertCentersMatch("decoded video", root, videoSurface, 1);
                assertCentersMatch("transport controls", root, centerControls, 1);
                Rect safeInsets = expectedSafeInsets(root);
                assertEquals(0, controller.getPaddingLeft());
                assertEquals(0, controller.getPaddingRight());
                assertEquals(safeInsets.left, bottomBar.getPaddingLeft());
                assertEquals(safeInsets.right, bottomBar.getPaddingRight());
                assertEquals(safeInsets.bottom, bottomBar.getPaddingBottom());
                assertEquals(safeInsets.left, progress.getPaddingLeft());
                assertEquals(safeInsets.right, progress.getPaddingRight());
                assertTransparentBackground(activity.findViewById(
                        androidx.media3.ui.R.id.exo_controls_background));
                assertTransparentBackground(activity.findViewById(
                        androidx.media3.ui.R.id.exo_bottom_bar));
                assertEquals(View.VISIBLE, previous.getVisibility());
                assertEquals(View.VISIBLE, next.getVisibility());
                assertTrue(previous.isEnabled());
                assertTrue(next.isEnabled());
                assertTrue(previous.getWidth() >= dp(target, 48));
                assertTrue(previous.getHeight() >= dp(target, 48));
                assertTrue(next.getWidth() >= dp(target, 48));
                assertTrue(next.getHeight() >= dp(target, 48));
                assertTrue(previous.getContentDescription().toString().contains("S3 E10"));
                assertTrue(next.getContentDescription().toString().contains("S4 E2"));
                previousRef.set(previous);
                nextRef.set(next);
            });
            SystemClock.sleep(250L);

            Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
            File screenshotFile = new File(
                    target.getExternalFilesDir(null),
                    "norva-player-episode-navigation.png");
            try (FileOutputStream output = new FileOutputStream(screenshotFile, false)) {
                assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output));
            }
            int sampleX = screenshot.getWidth() * 3 / 4;
            int sampleY = screenshot.getHeight() / 4;
            int controlsVisiblePixel = screenshot.getPixel(sampleX, sampleY);
            screenshot.recycle();

            instrumentation.runOnMainSync(() -> {
                PlayerView playerView = activity.findViewById(R.id.norva_player_view);
                playerView.hideController();
            });
            SystemClock.sleep(250L);
            Bitmap controlsHidden = instrumentation.getUiAutomation().takeScreenshot();
            int controlsHiddenPixel = controlsHidden.getPixel(sampleX, sampleY);
            controlsHidden.recycle();
            assertTrue("controller must not wash out the decoded frame",
                    rgbDistance(controlsVisiblePixel, controlsHiddenPixel) <= 24);
            instrumentation.runOnMainSync(() -> {
                PlayerView playerView = activity.findViewById(R.id.norva_player_view);
                playerView.showController();
            });
            SystemClock.sleep(150L);

            instrumentation.runOnMainSync(() -> previousRef.get().performClick());
            long deadline = SystemClock.elapsedRealtime() + 3_000L;
            while (!activity.isFinishing() && SystemClock.elapsedRealtime() < deadline) {
                SystemClock.sleep(25L);
            }
            assertTrue("Previous must hand off by closing, not seek to zero",
                    activity.isFinishing());
        } finally {
            Activity activity = activityRef.get();
            if (activity != null && !activity.isFinishing()) {
                instrumentation.runOnMainSync(activity::finish);
            }
            instrumentation.removeMonitor(monitor);
            try { target.unregisterReceiver(receiver); } catch (Exception ignored) { }
            //noinspection ResultOfMethodCallIgnored
            fixture.delete();
        }
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static void assertCentersMatch(
            String label, View reference, View candidate, int tolerancePx) {
        int[] referenceLocation = new int[2];
        int[] candidateLocation = new int[2];
        reference.getLocationInWindow(referenceLocation);
        candidate.getLocationInWindow(candidateLocation);
        int referenceCenterX2 = referenceLocation[0] * 2 + reference.getWidth();
        int referenceCenterY2 = referenceLocation[1] * 2 + reference.getHeight();
        int candidateCenterX2 = candidateLocation[0] * 2 + candidate.getWidth();
        int candidateCenterY2 = candidateLocation[1] * 2 + candidate.getHeight();
        assertTrue(label + " must be horizontally centered: expected x2="
                        + referenceCenterX2 + " actual x2=" + candidateCenterX2,
                Math.abs(referenceCenterX2 - candidateCenterX2) <= tolerancePx * 2);
        assertTrue(label + " must be vertically centered: expected y2="
                        + referenceCenterY2 + " actual y2=" + candidateCenterY2,
                Math.abs(referenceCenterY2 - candidateCenterY2) <= tolerancePx * 2);
    }

    private static Rect expectedSafeInsets(View root) {
        WindowInsets insets = root.getRootWindowInsets();
        assertNotNull(insets);
        int left = 0;
        int top = 0;
        int right = 0;
        int bottom = 0;
        DisplayCutout cutout = insets.getDisplayCutout();
        if (cutout != null) {
            left = cutout.getSafeInsetLeft();
            top = cutout.getSafeInsetTop();
            right = cutout.getSafeInsetRight();
            bottom = cutout.getSafeInsetBottom();
        }
        android.graphics.Insets nav = insets.getInsetsIgnoringVisibility(
                WindowInsets.Type.navigationBars());
        android.graphics.Insets gestures = insets.getInsets(
                WindowInsets.Type.mandatorySystemGestures());
        return new Rect(
                Math.max(left, Math.max(nav.left, gestures.left)),
                Math.max(top, Math.max(nav.top, gestures.top)),
                Math.max(right, Math.max(nav.right, gestures.right)),
                Math.max(bottom, Math.max(nav.bottom, gestures.bottom)));
    }

    private static void assertTransparentBackground(View view) {
        assertNotNull(view);
        assertTrue(view.getBackground() instanceof ColorDrawable);
        assertEquals(Color.TRANSPARENT, ((ColorDrawable) view.getBackground()).getColor());
    }

    private static int rgbDistance(int left, int right) {
        return Math.abs(Color.red(left) - Color.red(right))
                + Math.abs(Color.green(left) - Color.green(right))
                + Math.abs(Color.blue(left) - Color.blue(right));
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
