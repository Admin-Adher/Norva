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

/** Host supplies an ordinary, owned, short-lived playback session and expires
 * it afterwards. Tests the actual native player, not natural catalogue login.
 * Never include provider URLs or session credentials in the result receipt.
 */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public final class NativeOwnedVodTimelineInstrumentedTest {
    private static String safeError(androidx.media3.common.PlaybackException error) {
        if (error == null) return "none";
        String result = error.getErrorCodeName();
        Throwable cause = error;
        for (int depth = 0; cause != null && depth < 8; depth++, cause = cause.getCause()) {
            if (cause instanceof androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException http =
                        (androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) cause;
                return result + " httpStatus=" + http.responseCode + " requestedByte=" + http.dataSpec.position
                        + " requestedLength=" + http.dataSpec.length;
            }
        }
        return result;
    }
    private static ExoPlayer player(Activity activity) throws Exception {
        Field field = activity.getClass().getDeclaredField("player");
        field.setAccessible(true);
        return (ExoPlayer) field.get(activity);
    }

    private static JSONObject advance(Instrumentation instrumentation, ExoPlayer player,
            long target, long deadlineMs) throws Exception {
        long[] state = new long[3];
        instrumentation.runOnMainSync(() -> {
            state[1] = player.getVideoDecoderCounters() == null ? 0 : player.getVideoDecoderCounters().renderedOutputBufferCount;
            state[2] = player.getAudioDecoderCounters() == null ? 0 : player.getAudioDecoderCounters().renderedOutputBufferCount;
        });
        long videoBefore = state[1], audioBefore = state[2];
        long started = SystemClock.elapsedRealtime();
        do {
            instrumentation.runOnMainSync(() -> {
                assertNull("Native playback error at targetMs=" + target + " " + safeError(player.getPlayerError()), player.getPlayerError());
                state[0] = player.getCurrentPosition();
                state[1] = player.getVideoDecoderCounters() == null ? 0 : player.getVideoDecoderCounters().renderedOutputBufferCount;
                state[2] = player.getAudioDecoderCounters() == null ? 0 : player.getAudioDecoderCounters().renderedOutputBufferCount;
            });
            if (state[0] >= target + 5000 && state[0] <= target + 30000
                    && state[1] > videoBefore + 24 && state[2] > audioBefore + 24) {
                return new JSONObject().put("targetMs", target).put("positionMs", state[0])
                        .put("newVideoBuffers", state[1] - videoBefore).put("newAudioBuffers", state[2] - audioBefore)
                        .put("elapsedMs", SystemClock.elapsedRealtime() - started);
            }
            SystemClock.sleep(200);
        } while (SystemClock.elapsedRealtime() - started < deadlineMs);
        fail("Audio/video progression at requested position not proven");
        return null;
    }

    @Test public void ownedVodResumesAndSeeksWithActualAudioAndVideo() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        File fixture = new File(context.getFilesDir(), "native-owned-vod-qa.json");
        File receipt = new File(context.getFilesDir(), "native-owned-vod-result.json");
        String required = InstrumentationRegistry.getArguments().getString("norvaRequireOwnedVodFixture");
        assertTrue(required == null || "true".equals(required) || "false".equals(required));
        if ("true".equals(required)) assertTrue("Required owned VOD fixture missing", fixture.isFile());
        else Assume.assumeTrue("Owned VOD fixture not supplied", fixture.isFile());
        assertFalse("Stale playback result", receipt.exists());
        JSONObject config = new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
        assertTrue(config.getString("runNonce").matches("[a-f0-9]{32}"));
        int resumeSeconds = config.getInt("resumeSeconds");
        int seekSeconds = config.getInt("seekSeconds");
        assertTrue(resumeSeconds >= 0 && resumeSeconds <= 86000);
        assertTrue(seekSeconds >= 0 && seekSeconds <= 86000 && seekSeconds != resumeSeconds);
        String activityName = context.getPackageName() + ".PlayerActivity";
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(activityName, null, false);
        Activity activity = null;
        try {
            assertTrue("Cannot consume fixture", fixture.delete());
            context.startActivity(new Intent().setClassName(context, activityName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("url", config.getString("url")).putExtra("title", "Norva owned VOD QA")
                    .putExtra("sourceId", config.getString("sourceId")).putExtra("itemId", config.getString("itemId"))
                    .putExtra("itemType", config.getString("itemType"))
                    .putExtra("playbackSessionId", config.getString("sessionId"))
                    .putExtra("resumeSeconds", resumeSeconds));
            activity = instrumentation.waitForMonitorWithTimeout(monitor, 10000);
            assertNotNull("Player did not open", activity);
            ExoPlayer player = player(activity);
            assertNotNull(player);
            JSONObject resumed = advance(instrumentation, player, resumeSeconds * 1000L, 90000);
            instrumentation.runOnMainSync(() -> player.seekTo(seekSeconds * 1000L));
            JSONObject sought = advance(instrumentation, player, seekSeconds * 1000L, 60000);
            Files.write(receipt.toPath(), new JSONObject().put("runNonce", config.getString("runNonce"))
                    .put("resume", resumed).put("seek", sought).toString().getBytes(StandardCharsets.UTF_8));
        } finally {
            if (activity != null) { final Activity opened = activity; instrumentation.runOnMainSync(opened::finish); }
            instrumentation.removeMonitor(monitor);
            fixture.delete();
        }
    }
}
