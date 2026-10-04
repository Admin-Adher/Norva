package tv.norva.tv;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Real TV error UI and D-pad hand-off, using only an ephemeral loopback origin. */
@RunWith(AndroidJUnit4.class)
public final class MovieVersionRecoveryInstrumentedTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();

    @Test public void loadingTerminalBackgroundAndExplicitOtherVersionsReturnExactFile() throws Exception {
        try (Origin origin = new Origin(403);
             ActivityScenario<PlayerActivity> scenario = launch(origin)) {
            assertTrue(origin.firstRequest.await(8, TimeUnit.SECONDS));
            scenario.onActivity(activity -> {
                assertEquals(View.GONE, activity.findViewById(R.id.norva_tv_player_error_panel).getVisibility());
                assertEquals(View.GONE, activity.findViewById(R.id.norva_tv_player_error_change_version_button).getVisibility());
            });
            origin.release.countDown();
            awaitTerminal(scenario);
            assertOtherVersionsFocused(scenario);
            int requestsBeforeBackground = origin.requests.get();
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            SystemClock.sleep(200);
            assertOtherVersionsFocused(scenario);
            assertEquals("Returning must not probe another copy", requestsBeforeBackground, origin.requests.get());

            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
            Instrumentation.ActivityResult result = scenario.getResult();
            assertEquals(Activity.RESULT_OK, result.getResultCode());
            Intent data = result.getResultData();
            assertNotNull(data);
            assertTrue(data.getBooleanExtra(PlayerActivity.EXTRA_OPEN_MOVIE_VERSION_RECOVERY, false));
            assertEquals("fixture-source", data.getStringExtra("sourceId"));
            assertEquals("movie", data.getStringExtra("itemType"));
            assertEquals("fixture-file", data.getStringExtra("itemId"));
            assertEquals(0L, data.getLongExtra("positionSeconds", -1));
            assertFalse(data.getBooleanExtra("retryPlayback", true));
            assertEquals("variant_change", data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_CLOSE_REASON));
            assertNotNull(data.getStringExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID));
            assertEquals(requestsBeforeBackground, origin.requests.get());
        }
    }

    @Test public void retryStaysOnSameFileAndRemoteBackCancelsWithoutVersionHandoff() throws Exception {
        try (Origin origin = new Origin(403);
             ActivityScenario<PlayerActivity> scenario = launch(origin)) {
            origin.release.countDown();
            awaitTerminal(scenario);
            assertOtherVersionsFocused(scenario);
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_RIGHT);
            scenario.onActivity(activity -> assertEquals(R.id.norva_tv_player_retry_button, activity.getCurrentFocus().getId()));
            int before = origin.requests.get();
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
            scenario.onActivity(activity -> {
                assertEquals(View.GONE, activity.findViewById(R.id.norva_tv_player_error_panel).getVisibility());
                assertTrue((Boolean) field(activity, "freshStreamRequested"));
            });
            // No bridge resolver exists in this isolated fixture: requesting a
            // fresh exact-file URL must not silently open a sibling or old URL.
            assertEquals(before, origin.requests.get());
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            Intent result = scenario.getResult().getResultData();
            assertNotNull(result);
            assertFalse(result.getBooleanExtra(PlayerActivity.EXTRA_OPEN_MOVIE_VERSION_RECOVERY, false));
            assertFalse(result.getBooleanExtra("retryPlayback", true));
        }
    }

    @Test public void accountConflictKeepsOtherVersionsHiddenAndDpadSkipsHiddenAction() throws Exception {
        try (Origin origin = new Origin(458);
             ActivityScenario<PlayerActivity> scenario = launch(origin)) {
            origin.release.countDown();
            long until = SystemClock.elapsedRealtime() + 8000;
            AtomicReference<Boolean> visible = new AtomicReference<>(false);
            while (!visible.get() && SystemClock.elapsedRealtime() < until) {
                scenario.onActivity(activity -> visible.set(activity.findViewById(R.id.norva_tv_player_error_panel).getVisibility() == View.VISIBLE));
                SystemClock.sleep(40);
            }
            assertTrue(visible.get());
            scenario.onActivity(activity -> {
                assertEquals(View.GONE, activity.findViewById(R.id.norva_tv_player_error_change_version_button).getVisibility());
                assertEquals(R.id.norva_tv_player_retry_button, activity.getCurrentFocus().getId());
            });
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_LEFT);
            scenario.onActivity(activity -> assertEquals(R.id.norva_tv_player_error_back_button, activity.getCurrentFocus().getId()));
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_DPAD_CENTER);
            assertFalse(scenario.getResult().getResultData().getBooleanExtra(PlayerActivity.EXTRA_OPEN_MOVIE_VERSION_RECOVERY, false));
            assertEquals(1, origin.requests.get());
        }
    }

    private ActivityScenario<PlayerActivity> launch(Origin origin) {
        Context target = instrumentation.getTargetContext();
        Intent intent = new Intent(target, PlayerActivity.class)
                .putExtra(PlayerActivity.EXTRA_URL, origin.url())
                .putExtra(PlayerActivity.EXTRA_TITLE, "Norva version recovery fixture")
                .putExtra(PlayerActivity.EXTRA_SOURCE_ID, "fixture-source")
                .putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "movie")
                .putExtra(PlayerActivity.EXTRA_ITEM_ID, "fixture-file")
                .putExtra(PlayerActivity.EXTRA_MOVIE_VERSION_RECOVERY, true)
                .putExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID, UUID.randomUUID().toString());
        return ActivityScenario.launchActivityForResult(intent);
    }

    private void awaitTerminal(ActivityScenario<PlayerActivity> scenario) throws Exception {
        long until = SystemClock.elapsedRealtime() + 12000;
        AtomicReference<Boolean> terminal = new AtomicReference<>(false);
        while (!terminal.get() && SystemClock.elapsedRealtime() < until) {
            scenario.onActivity(activity -> {
                // Exercise the real bounded retry path. Advance its existing
                // timeout only after it reaches the fresh-stream waiting state;
                // no production timeout or network policy is changed.
                if (Boolean.TRUE.equals(field(activity, "freshStreamRequested"))) {
                    ((Runnable) field(activity, "freshStreamTimeout")).run();
                }
                terminal.set(activity.findViewById(R.id.norva_tv_player_error_panel).getVisibility() == View.VISIBLE);
            });
            SystemClock.sleep(50);
        }
        assertTrue("Expected the real terminal error surface", terminal.get());
    }

    private void assertOtherVersionsFocused(ActivityScenario<PlayerActivity> scenario) {
        scenario.onActivity(activity -> {
            TextView button = activity.findViewById(R.id.norva_tv_player_error_change_version_button);
            assertEquals(View.VISIBLE, button.getVisibility());
            assertEquals(activity.getString(R.string.player_other_versions), button.getText().toString());
            assertEquals(button.getId(), activity.getCurrentFocus().getId());
            assertTrue("Action must remain inside its TV error panel", button.getWidth() > 0 && button.getHeight() > 0);
            if (button.getLayout() != null) assertTrue("Text must fit at this font scale",
                    button.getLayout().getHeight() + button.getCompoundPaddingTop() + button.getCompoundPaddingBottom() <= button.getHeight());
            TextView message = activity.findViewById(R.id.norva_tv_player_error_message);
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE, message.getAccessibilityLiveRegion());
        });
    }

    private static Object field(Object target, String name) {
        try {
            Field field = PlayerActivity.class.getDeclaredField(name);
            field.setAccessible(true);
            return field.get(target);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private static final class Origin implements AutoCloseable {
        final AtomicInteger requests = new AtomicInteger();
        final CountDownLatch firstRequest = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        private final int status;
        private final ServerSocket server;
        private final Thread thread;
        private volatile boolean closed;
        Origin(int status) throws Exception {
            this.status = status;
            server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(this::serve, "norva-tv-version-recovery-origin");
            thread.setDaemon(true); thread.start();
        }
        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/fixture.mp4"; }
        private void serve() {
            while (!closed) {
                try (Socket socket = server.accept(); InputStream input = socket.getInputStream(); OutputStream output = socket.getOutputStream()) {
                    socket.setSoTimeout(2000);
                    int state = 0;
                    while (state < 4) {
                        int value = input.read(); if (value < 0) break;
                        int expected = state % 2 == 0 ? '\r' : '\n';
                        state = value == expected ? state + 1 : value == '\r' ? 1 : 0;
                    }
                    requests.incrementAndGet(); firstRequest.countDown(); release.await(10, TimeUnit.SECONDS);
                    output.write(("HTTP/1.1 " + status + " Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    output.flush();
                } catch (Exception ignored) { /* UI assertions report failures. */ }
            }
        }
        @Override public void close() throws Exception {
            closed = true; release.countDown(); server.close(); thread.join(1000);
        }
    }
}
