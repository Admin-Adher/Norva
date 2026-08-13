package tv.norva.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.View;
import android.widget.TextView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** Emulator gate: the first provider 458 must become one terminal, accessible state. */
@RunWith(AndroidJUnit4.class)
public final class ProviderBusyInstrumentedTest {
    @Test
    public void first458StopsWithoutFallbackAndBackClosesThePlayer() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        AtomicReference<Activity> activityRef = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor =
                instrumentation.addMonitor(PlayerActivity.class.getName(), null, false);

        try (BusyHttpServer server = new BusyHttpServer()) {
            Intent launch = new Intent(target, PlayerActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(PlayerActivity.EXTRA_URL, server.url())
                    .putExtra(PlayerActivity.EXTRA_TITLE, "Norva provider conflict gate")
                    .putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "movie")
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, "provider-busy-fixture")
                    .putExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID,
                            UUID.randomUUID().toString());
            target.startActivity(launch);
            // API 35 emulator cold-start class verification can exceed five
            // seconds even though the Activity is launching normally.
            Activity activity = instrumentation.waitForMonitorWithTimeout(monitor, 15_000);
            activityRef.set(activity);
            assertNotNull(activity);

            TextView title = waitForVisibleText(
                    instrumentation,
                    activity,
                    R.id.norva_player_error_title,
                    target.getString(R.string.player_error_provider_in_use_title),
                    12_000L);
            assertNotNull(title);
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE,
                    ((TextView) activity.findViewById(R.id.norva_player_error_message))
                            .getAccessibilityLiveRegion());
            SystemClock.sleep(1_000L);
            assertEquals("HTTP 458 must not enter a direct/gateway retry cascade",
                    1, server.requestCount());

            instrumentation.runOnMainSync(activity::onBackPressed);
            long deadline = SystemClock.elapsedRealtime() + 3_000L;
            while (!activity.isFinishing() && SystemClock.elapsedRealtime() < deadline) {
                SystemClock.sleep(50L);
            }
            assertTrue(activity.isFinishing());
        } finally {
            Activity activity = activityRef.get();
            if (activity != null && !activity.isFinishing()) {
                instrumentation.runOnMainSync(activity::finish);
            }
            instrumentation.removeMonitor(monitor);
        }
    }

    private static TextView waitForVisibleText(
            Instrumentation instrumentation,
            Activity activity,
            int id,
            String expected,
            long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        AtomicReference<TextView> result = new AtomicReference<>();
        while (SystemClock.elapsedRealtime() < deadline) {
            instrumentation.runOnMainSync(() -> {
                TextView view = activity.findViewById(id);
                if (view != null && view.getVisibility() == View.VISIBLE
                        && expected.contentEquals(view.getText())) {
                    result.set(view);
                }
            });
            if (result.get() != null) return result.get();
            SystemClock.sleep(50L);
        }
        return null;
    }

    private static final class BusyHttpServer implements AutoCloseable {
        private final ServerSocket server;
        private final AtomicInteger requests = new AtomicInteger();
        private final Thread thread;
        private volatile boolean closed;

        BusyHttpServer() throws Exception {
            server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(this::serve, "norva-provider-busy-origin");
            thread.setDaemon(true);
            thread.start();
        }

        String url() {
            return "http://127.0.0.1:" + server.getLocalPort() + "/busy.mkv";
        }

        int requestCount() {
            return requests.get();
        }

        private void serve() {
            while (!closed) {
                try (Socket socket = server.accept();
                     InputStream input = socket.getInputStream();
                     OutputStream output = socket.getOutputStream()) {
                    while (input.read() != -1 && input.available() > 0) { }
                    requests.incrementAndGet();
                    byte[] body = "{\"code\":\"PROVIDER_BUSY\"}"
                            .getBytes(StandardCharsets.UTF_8);
                    String headers = "HTTP/1.1 458 Provider Busy\r\n"
                            + "Content-Type: application/json\r\n"
                            + "Content-Length: " + body.length + "\r\n"
                            + "Connection: close\r\n\r\n";
                    output.write(headers.getBytes(StandardCharsets.US_ASCII));
                    output.write(body);
                    output.flush();
                } catch (Exception ignored) {
                    if (!closed) { /* the assertion supplies the useful failure */ }
                }
            }
        }

        @Override
        public void close() throws Exception {
            closed = true;
            server.close();
            thread.join(1_000L);
        }
    }
}
