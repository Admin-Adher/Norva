package tv.norva.playback;

import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real production follower playback. The host supplies only short-lived QA sessions.
 * Host responsibilities: prove the shared-live-hls response and incomplete producer,
 * heartbeat both sessions, revoke the leader after the ready receipt, then write
 * the matching departure receipt only after API and database confirmation.
 * This test never turns API-only decoding into a claim of two UI clients.
 */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public final class NativeLiveJoinPlaybackInstrumentedTest {
    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    @Test public void followerRendersBeyondItsBufferAfterLeaderDeparture() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        File fixture = new File(context.getFilesDir(), "native-live-join-qa.json");
        File ready = new File(context.getFilesDir(), "native-live-join-ready.json");
        File departed = new File(context.getFilesDir(), "native-live-join-departed.json");
        String required = InstrumentationRegistry.getArguments().getString("norvaRequireLiveJoinFixture");
        assertTrue("Invalid live-join requirement", required == null || "true".equals(required) || "false".equals(required));
        if ("true".equals(required)) assertTrue("Required live-join fixture missing", fixture.isFile());
        else Assume.assumeTrue("Live-join session not supplied", fixture.isFile());
        assertFalse("Stale ready receipt", ready.exists());
        assertFalse("Stale departure receipt", departed.exists());
        JSONObject config = new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
        assertEquals("shared-live-hls", config.getString("transport"));
        assertTrue("Expected an incomplete conversion", config.getBoolean("producerIncomplete"));
        assertTrue("Expected HTTPS playback", config.getString("url").startsWith("https://"));
        assertTrue("Fixture too short for continuation proof", config.getLong("durationMs") >= 180000);
        String nonce = config.getString("runNonce");
        assertTrue("Invalid run nonce", nonce.matches("[a-f0-9]{32}"));
        String activityName = context.getPackageName() + ".PlayerActivity";
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(activityName, null, false);
        Activity activity = null;
        try {
            assertTrue("Cannot consume fixture", fixture.delete());
            context.startActivity(new Intent().setClassName(context, activityName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("url", config.getString("url"))
                    .putExtra("title", "Norva shared conversion QA")
                    .putExtra("itemType", "movie")
                    .putExtra("sourceId", config.getString("sourceId"))
                    .putExtra("itemId", config.getString("itemId"))
                    .putExtra("playbackSessionId", config.getString("sessionId")));
            activity = instrumentation.waitForMonitorWithTimeout(monitor, 10000);
            assertNotNull("Native follower did not open", activity);
            ExoPlayer player = (ExoPlayer) field(activity, "player");
            assertNotNull(player);
            long[] sample = new long[3];
            Runnable observe = () -> {
                assertTrue("Native follower playback error: " + (player.getPlayerError() == null
                        ? "none" : player.getPlayerError().getErrorCodeName()), player.getPlayerError() == null);
                sample[0] = player.getVideoDecoderCounters() == null ? 0
                        : player.getVideoDecoderCounters().renderedOutputBufferCount;
                sample[1] = player.getCurrentPosition();
                sample[2] = player.getBufferedPosition();
            };
            long deadline = SystemClock.elapsedRealtime() + 60000;
            do {
                instrumentation.runOnMainSync(observe);
                if (sample[0] > 24 && sample[1] > 1000) break;
                SystemClock.sleep(200);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Follower rendered no actual video", sample[0] > 24 && sample[1] > 1000);
            Files.write(ready.toPath(), new JSONObject().put("runNonce", nonce)
                    .put("renderedFrames", sample[0]).toString().getBytes(StandardCharsets.UTF_8));
            deadline = SystemClock.elapsedRealtime() + 30000;
            while (!departed.isFile() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(200);
            assertTrue("Leader departure was not confirmed", departed.isFile());
            JSONObject receipt = new JSONObject(new String(Files.readAllBytes(departed.toPath()), StandardCharsets.UTF_8));
            assertEquals("Departure belongs to another run", nonce, receipt.getString("runNonce"));
            assertTrue("Leader still active", receipt.getBoolean("leaderExpired"));
            assertTrue("Follower lost authority", receipt.getBoolean("followerActive"));
            instrumentation.runOnMainSync(observe);
            long bufferedAtDeparture = Math.max(sample[1], sample[2]);
            long framesAtDeparture = sample[0];
            // Passing requires video beyond the buffer observed AFTER the leader left.
            // Merely playing prefetched segments for a few seconds is insufficient.
            assertTrue("Fixture is fully buffered; cannot prove continuation",
                    bufferedAtDeparture < config.getLong("durationMs") - 15000);
            deadline = SystemClock.elapsedRealtime() + 120000;
            do {
                instrumentation.runOnMainSync(observe);
                if (sample[1] > bufferedAtDeparture + 5000 && sample[0] > framesAtDeparture + 48) break;
                SystemClock.sleep(500);
            } while (SystemClock.elapsedRealtime() < deadline);
            assertTrue("Follower did not progress beyond its pre-departure buffer",
                    sample[1] > bufferedAtDeparture + 5000 && sample[0] > framesAtDeparture + 48);
        } finally {
            if (activity != null) {
                Activity opened = activity;
                instrumentation.runOnMainSync(opened::finish);
            }
            instrumentation.removeMonitor(monitor);
            fixture.delete();
            ready.delete();
            departed.delete();
        }
    }
}
