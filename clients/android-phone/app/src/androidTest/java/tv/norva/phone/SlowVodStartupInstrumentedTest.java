package tv.norva.phone;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.*;
import android.os.SystemClock;
import android.view.View;
import android.widget.TextView;
import androidx.core.content.ContextCompat;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import tv.norva.playback.NativeVodStartupProgress;

/** Real local media I/O; never uses a provider account or substitutes a first-frame callback. */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public final class SlowVodStartupInstrumentedTest {
    @Test public void progressingHeaderPastThirtyFiveSecondsRendersWithoutRestart() throws Exception {
        try (Fixture fixture = new Fixture(true)) {
            AtomicInteger initialRoute = new AtomicInteger();
            fixture.ins.runOnMainSync(() -> initialRoute.set(
                    (Integer) field(fixture.activity, "playbackRouteGeneration")));
            SystemClock.sleep(36000);
            fixture.ins.runOnMainSync(() -> {
                assertFalse((Boolean) field(fixture.activity, "firstFrameForCurrentRoute"));
                assertTrue(fixture.progress().mayRenewLease(SystemClock.elapsedRealtime()));
                assertEquals(View.VISIBLE, ((View) field(fixture.activity, "stateOverlay")).getVisibility());
                assertTrue(((TextView) field(fixture.activity, "stateMessageView")).getText().length() > 0);
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS,
                        ((View) field(fixture.activity, "playerView")).getImportantForAccessibility());
            });
            fixture.awaitFrame(20000);
            // This fixture's Matroska cues follow its clusters. Media3 may
            // legitimately seek to those cues and back on the same route.
            assertEquals("Progress must not restart the file from byte zero", 1,
                    fixture.origin.zeroOffsetRequests.get());
            fixture.ins.runOnMainSync(() -> assertEquals(
                    "Progress must keep the same media route until the first frame",
                    initialRoute.get(), (int) (Integer) field(fixture.activity, "playbackRouteGeneration")));
            assertFalse(fixture.progress().active());
        }
    }

    @Test public void absoluteDeadlineIsTerminalAndOnlyExplicitRetryReopens() throws Exception {
        try (Fixture fixture = new Fixture(true)) {
            fixture.ins.runOnMainSync(() -> {
                long now = SystemClock.elapsedRealtime();
                long generation = fixture.progress().begin(now - NativeVodStartupProgress.STARTUP_LIMIT_MS);
                fixture.progress().bytesRead(generation, 1, now);
                ((Runnable) field(fixture.activity, "bufferWatchdog")).run();
                assertEquals(View.VISIBLE, ((View) field(fixture.activity, "errorPanel")).getVisibility());
                assertFalse(fixture.progress().active());
                assertFalse((Boolean) field(fixture.activity, "freshStreamRequested"));
                assertEquals(Player.STATE_IDLE, fixture.player().getPlaybackState());
                assertFalse((Boolean) invoke(fixture.activity, "shouldRunPlaybackHeartbeat"));
                ((Runnable) field(fixture.activity, "bufferWatchdog")).run();
            });
            fixture.awaitDisconnected();
            assertEquals(1, fixture.origin.requests.get());
            fixture.origin.slow = false;
            AtomicInteger retries = new AtomicInteger();
            BroadcastReceiver receiver = new BroadcastReceiver() {
                @Override public void onReceive(Context context, Intent request) {
                    if (!"watchdog-fixture".equals(request.getStringExtra(PlayerActivity.EXTRA_SOURCE_ID))) return;
                    retries.incrementAndGet();
                    try {
                        String payload = new JSONObject().put("sourceId", "watchdog-fixture")
                                .put("itemId", "slow-start").put("url", fixture.origin.url()).toString();
                        fixture.target.sendBroadcast(new Intent(PlayerActivity.ACTION_APPLY_FRESH_STREAM)
                                .setPackage(fixture.target.getPackageName())
                                .putExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN,
                                        request.getStringExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN))
                                .putExtra(PlayerActivity.EXTRA_RECOVERY_PAYLOAD, payload));
                    } catch (Exception error) { throw new AssertionError(error); }
                }
            };
            ContextCompat.registerReceiver(fixture.target, receiver,
                    new IntentFilter(PlayerActivity.ACTION_REQUEST_FRESH_STREAM), ContextCompat.RECEIVER_NOT_EXPORTED);
            try {
                fixture.ins.runOnMainSync(() -> ((View) field(fixture.activity, "retryButton")).performClick());
                fixture.awaitFrame(20000);
                assertEquals(1, retries.get());
            } finally { fixture.target.unregisterReceiver(receiver); }
        }
    }

    @Test public void backgroundAndBackReleaseThePreparingReaderAndForegroundCanPlay() throws Exception {
        try (Fixture fixture = new Fixture(true)) {
            fixture.ins.runOnMainSync(() -> invoke(fixture.activity, "deactivatePlaybackForBackground"));
            fixture.awaitDisconnected();
            assertFalse(fixture.progress().active());
            fixture.ins.runOnMainSync(() -> {
                assertEquals(Player.STATE_IDLE, fixture.player().getPlaybackState());
                assertFalse((Boolean) invoke(fixture.activity, "shouldRunPlaybackHeartbeat"));
            });
            fixture.origin.slow = false;
            fixture.ins.runOnMainSync(() -> {
                set(fixture.activity, "playbackActive", true);
                invoke(fixture.activity, "resumePlaybackAfterForegroundReturn");
            });
            fixture.awaitFrame(20000);
            fixture.ins.runOnMainSync(fixture.activity::onBackPressed);
            assertTrue(fixture.activity.isFinishing());
            fixture.awaitDisconnected();
            assertFalse(fixture.progress().mayRenewLease(SystemClock.elapsedRealtime()));
        }
    }

    @Test public void backDuringStartupClosesTheRealSocketAndStopsLeaseRenewal() throws Exception {
        try (Fixture fixture = new Fixture(true)) {
            fixture.ins.runOnMainSync(() -> {
                // Validate the production predicate with structurally valid local
                // fixture identities. No credential reply or remote call is made.
                set(fixture.activity, "playbackAuthChannelId", java.util.UUID.randomUUID().toString());
                set(fixture.activity, "playbackSessionId", java.util.UUID.randomUUID().toString());
                assertTrue((Boolean) invoke(fixture.activity, "shouldRunPlaybackHeartbeat"));
                fixture.activity.onBackPressed();
                assertFalse((Boolean) invoke(fixture.activity, "shouldRunPlaybackHeartbeat"));
                assertFalse(fixture.progress().active());
            });
            fixture.awaitDisconnected();
            assertTrue(fixture.activity.isFinishing());
            assertEquals(1, fixture.origin.requests.get());
        }
    }

    private static Object field(Object owner, String name) {
        try { Field value = owner.getClass().getDeclaredField(name); value.setAccessible(true); return value.get(owner); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private static void set(Object owner, String name, Object value) {
        try { Field target = owner.getClass().getDeclaredField(name); target.setAccessible(true); target.set(owner, value); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private static Object invoke(Object owner, String name) {
        try { Method method = owner.getClass().getDeclaredMethod(name); method.setAccessible(true); return method.invoke(owner); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private static void await(java.util.function.BooleanSupplier condition, long timeoutMs) {
        long until = SystemClock.elapsedRealtime() + timeoutMs;
        while (!condition.getAsBoolean() && SystemClock.elapsedRealtime() < until) SystemClock.sleep(30);
        assertTrue("Timed out waiting for fixture evidence", condition.getAsBoolean());
    }

    private static final class Fixture implements AutoCloseable {
        final Instrumentation ins = InstrumentationRegistry.getInstrumentation();
        final Context target = ins.getTargetContext();
        final Instrumentation.ActivityMonitor monitor = ins.addMonitor(PlayerActivity.class.getName(), null, false);
        final Origin origin;
        final Activity activity;
        Fixture(boolean slow) throws Exception {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = ins.getContext().getAssets().open("s_h264_aac.mkv")) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            }
            origin = new Origin(bytes.toByteArray(), slow);
            target.startActivity(new Intent(target, PlayerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(PlayerActivity.EXTRA_URL, origin.url()).putExtra(PlayerActivity.EXTRA_TITLE, "Slow VOD fixture")
                    .putExtra(PlayerActivity.EXTRA_SOURCE_ID, "watchdog-fixture")
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, "slow-start").putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "movie"));
            activity = ins.waitForMonitorWithTimeout(monitor, 10000);
            assertNotNull(activity);
            await(() -> origin.requests.get() > 0, 10000);
        }
        NativeVodStartupProgress progress() { return (NativeVodStartupProgress) field(activity, "vodStartupProgress"); }
        ExoPlayer player() { return (ExoPlayer) field(activity, "player"); }
        void awaitFrame(long limit) {
            await(() -> { boolean[] rendered = {false};
                ins.runOnMainSync(() -> rendered[0] = (Boolean) field(activity, "firstFrameForCurrentRoute"));
                return rendered[0]; }, limit);
        }
        void awaitDisconnected() { await(() -> origin.active.get() == 0, 5000); }
        @Override public void close() throws Exception {
            if (!activity.isFinishing()) ins.runOnMainSync(activity::finish);
            ins.removeMonitor(monitor); origin.close();
        }
    }

    private static final class Origin implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        final byte[] bytes;
        final AtomicInteger requests = new AtomicInteger(), zeroOffsetRequests = new AtomicInteger(),
                active = new AtomicInteger();
        volatile boolean slow;
        Origin(byte[] bytes, boolean slow) throws IOException {
            this.bytes = bytes; this.slow = slow;
            Thread accept = new Thread(() -> {
                while (!server.isClosed()) try {
                    Socket socket = server.accept();
                    Thread serve = new Thread(() -> serve(socket), "slow-vod-response"); serve.setDaemon(true); serve.start();
                } catch (IOException ignored) { }
            }, "slow-vod-origin"); accept.setDaemon(true); accept.start();
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/fixture.mkv"; }
        void serve(Socket socket) {
            active.incrementAndGet();
            try (Socket current = socket) {
                BufferedReader request = new BufferedReader(new InputStreamReader(current.getInputStream(), StandardCharsets.US_ASCII));
                String line; int start = 0;
                while ((line = request.readLine()) != null && !line.isEmpty()) {
                    if (line.toLowerCase(java.util.Locale.ROOT).startsWith("range: bytes="))
                        start = Integer.parseInt(line.substring(line.indexOf('=') + 1, line.indexOf('-')));
                }
                requests.incrementAndGet();
                if (start == 0) zeroOffsetRequests.incrementAndGet();
                final boolean delayed = slow && start == 0;
                OutputStream out = current.getOutputStream();
                String range = start > 0 ? "Content-Range: bytes " + start + "-" + (bytes.length - 1) + "/" + bytes.length + "\r\n" : "";
                out.write(("HTTP/1.1 " + (start > 0 ? "206 Partial Content" : "200 OK")
                        + "\r\nContent-Type: video/x-matroska\r\nContent-Length: " + (bytes.length - start)
                        + "\r\n" + range + "Connection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                // A concurrent EOF observer proves the real player closed its socket.
                Thread disconnected = new Thread(() -> {
                    try { while (request.read() != -1) { } } catch (IOException ignored) { }
                    try { current.close(); } catch (IOException ignored) { }
                }, "slow-vod-disconnect"); disconnected.setDaemon(true); disconnected.start();
                int sent = start;
                if (delayed) for (int i = 0; i < 8; i++) {
                    if (current.isClosed() || server.isClosed()) return;
                    out.write(bytes[sent++]); out.flush();
                    // Small sleeps let Back/background tests observe prompt closure.
                    for (int pause = 0; pause < 100 && !current.isClosed() && !server.isClosed(); pause++) SystemClock.sleep(50);
                }
                if (!current.isClosed()) { out.write(bytes, sent, bytes.length - sent); out.flush(); }
            } catch (Exception ignored) { }
            finally { active.decrementAndGet(); }
        }
        @Override public void close() throws IOException { server.close(); }
    }
}
