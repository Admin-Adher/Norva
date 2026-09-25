package tv.norva.phone;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.*;
import android.os.SystemClock;
import android.view.View;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

/** Real Media3 startup refusal, with a resume point originally saved by another device. */
@RunWith(AndroidJUnit4.class)
public final class ResumeRecoveryInstrumentedTest {
    @Test public void refusalKeepsFiveMinutesAndRejectedResolutionEndsTheWait() throws Exception {
        Instrumentation ins = InstrumentationRegistry.getInstrumentation();
        Context target = ins.getTargetContext();
        CountDownLatch requested = new CountDownLatch(1);
        AtomicReference<Intent> request = new AtomicReference<>();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!"resume-recovery-fixture".equals(intent.getStringExtra(PlayerActivity.EXTRA_ITEM_ID))) return;
                request.set(new Intent(intent)); requested.countDown();
            }
        };
        ContextCompat.registerReceiver(target, receiver,
                new IntentFilter(PlayerActivity.ACTION_REQUEST_FRESH_STREAM), ContextCompat.RECEIVER_NOT_EXPORTED);
        Instrumentation.ActivityMonitor monitor = ins.addMonitor(PlayerActivity.class.getName(), null, false);
        Activity activity = null;
        try (ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))) {
            Thread origin = new Thread(() -> {
                while (!server.isClosed()) {
                    try (Socket socket = server.accept()) {
                        socket.setSoTimeout(2000);
                        java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream()));
                        for (String line; (line=reader.readLine()) != null && !line.isEmpty();) { }
                        byte[] body = "not a playable container".getBytes(StandardCharsets.UTF_8);
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: "
                                + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().write(body);
                    } catch (Exception ignored) { }
                }
            }, "norva-resume-refusal");
            origin.setDaemon(true); origin.start();
            target.startActivity(new Intent(target, PlayerActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(PlayerActivity.EXTRA_URL, "http://127.0.0.1:"+server.getLocalPort()+"/movie.mkv")
                    .putExtra(PlayerActivity.EXTRA_TITLE, "Resume recovery fixture")
                    .putExtra(PlayerActivity.EXTRA_SOURCE_ID, "resume-fixture-source")
                    .putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "movie")
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, "resume-recovery-fixture")
                    .putExtra(PlayerActivity.EXTRA_RESUME_SECONDS, 300));
            activity = ins.waitForMonitorWithTimeout(monitor, 15000);
            assertNotNull(activity);
            assertTrue("Actual extraction failure requests fresh resolution", requested.await(20, TimeUnit.SECONDS));
            assertEquals("An unreadable origin must not reset cross-device progress", 300L,
                    request.get().getLongExtra("positionSeconds", -1L));
            String token = request.get().getStringExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN);
            String payload = new JSONObject().put("sourceId", "resume-fixture-source")
                    .put("itemType", "movie").put("itemId", "resume-recovery-fixture")
                    .put("recoveryError", "resolution_unavailable").toString();
            target.sendBroadcast(new Intent(PlayerActivity.ACTION_APPLY_FRESH_STREAM).setPackage(target.getPackageName())
                    .putExtra(PlayerActivity.EXTRA_RECOVERY_TOKEN, token)
                    .putExtra(PlayerActivity.EXTRA_RECOVERY_PAYLOAD, payload));
            Activity shown = activity;
            long deadline = SystemClock.elapsedRealtime()+3000;
            AtomicReference<Boolean> visible = new AtomicReference<>(false);
            while (!visible.get() && SystemClock.elapsedRealtime()<deadline) {
                ins.runOnMainSync(() -> visible.set(shown.findViewById(R.id.norva_player_error_message).getVisibility()==View.VISIBLE));
                SystemClock.sleep(50);
            }
            assertTrue("Explicit rejection displays a terminal state without the 60-second timeout", visible.get());
            ins.runOnMainSync(shown::onBackPressed);
            assertTrue(shown.isFinishing());
        } finally {
            if (activity!=null && !activity.isFinishing()) { Activity shown=activity; ins.runOnMainSync(shown::finish); }
            target.unregisterReceiver(receiver); ins.removeMonitor(monitor);
        }
    }
}
