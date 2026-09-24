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
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.atomic.AtomicReference;

/** Opt-in live QA. The short-lived session is supplied through app-private storage, never the APK. */
@RunWith(AndroidJUnit4.class)
@androidx.media3.common.util.UnstableApi
public final class NativeMediaCachePlaybackInstrumentedTest {
    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(target);
    }
    @Test public void realPrivateCacheRendersSeeksRenewsAndPreservesPause() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        File fixture = new File(context.getFilesDir(), "native-cache-qa.json");
        Assume.assumeTrue("Live QA session not supplied", fixture.isFile());
        JSONObject config = new JSONObject(new String(Files.readAllBytes(fixture.toPath()), StandardCharsets.UTF_8));
        fixture.delete();
        JSONObject access = config.getJSONObject("mediaCache");
        SimpleDateFormat date = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        date.setTimeZone(TimeZone.getTimeZone("UTC"));
        // Bring the scheduled refresh forward for this test; the issued ticket and server expiry are unchanged.
        access.put("refreshAfter", date.format(new Date(System.currentTimeMillis() - 1000)));
        String activityName = context.getPackageName() + ".PlayerActivity";
        Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(activityName, null, false);
        Activity activity = null;
        try {
            context.startActivity(new Intent().setClassName(context, activityName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra("url", access.getString("playlistUrl"))
                    .putExtra("title", "Norva cache QA")
                    .putExtra("itemType", "movie")
                    .putExtra("sourceId", config.getString("sourceId"))
                    .putExtra("itemId", config.getString("itemId"))
                    .putExtra("playbackSessionId", config.getString("sessionId"))
                    .putExtra("mediaCache", access.toString()));
            activity = instrumentation.waitForMonitorWithTimeout(monitor, 10000);
            assertNotNull("Native player did not open", activity);
            final ExoPlayer player = (ExoPlayer) field(activity, "player");
            assertNotNull(player);
            long deadline = SystemClock.elapsedRealtime() + 45000;
            long[] evidence = new long[2];
            while (SystemClock.elapsedRealtime() < deadline) {
                instrumentation.runOnMainSync(() -> {
                    evidence[0] = player.getVideoDecoderCounters() == null ? 0
                            : player.getVideoDecoderCounters().renderedOutputBufferCount;
                    evidence[1] = player.getCurrentPosition();
                });
                if (evidence[0] > 24 && evidence[1] > 1000) break;
                SystemClock.sleep(500);
            }
            assertTrue("No actual frames from the authorized cache", evidence[0] > 24);
            NativeMediaCache cache = (NativeMediaCache) field(activity, "nativeMediaCache");
            Object before = field(cache, "access");
            cache.renewIfDue(config.getString("bearer"));
            deadline = SystemClock.elapsedRealtime() + 20000;
            while (field(cache, "access") == before && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(200);
            assertNotSame("Ticket renewal failed", before, field(cache, "access"));
            instrumentation.runOnMainSync(() -> { player.setPlaybackSpeed(2f); player.seekTo(45000); player.play(); });
            deadline = SystemClock.elapsedRealtime() + 30000;
            while (SystemClock.elapsedRealtime() < deadline) {
                instrumentation.runOnMainSync(() -> evidence[1] = player.getCurrentPosition());
                if (evidence[1] >= 55000) break;
                SystemClock.sleep(500);
            }
            AtomicReference<String> state = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> state.set("position=" + player.getCurrentPosition()
                    + ", buffered=" + player.getBufferedPosition() + ", state=" + player.getPlaybackState()
                    + ", play=" + player.getPlayWhenReady() + ", loading=" + player.isLoading()
                    + ", suppression=" + player.getPlaybackSuppressionReason()
                    + ", error=" + (player.getPlayerError() == null ? "none" : player.getPlayerError().getErrorCodeName())));
            assertTrue("Seek/2x playback did not advance: " + state.get(), evidence[1] >= 55000);
            instrumentation.runOnMainSync(() -> { player.pause(); evidence[1] = player.getCurrentPosition(); });
            long pausedAt = evidence[1];
            SystemClock.sleep(3000);
            instrumentation.runOnMainSync(() -> { evidence[1] = player.getCurrentPosition(); assertFalse(player.getPlayWhenReady()); });
            assertTrue("Explicit pause was lost", Math.abs(evidence[1] - pausedAt) < 500);
        } finally {
            if (activity != null) { final Activity opened = activity; instrumentation.runOnMainSync(opened::finish); }
            instrumentation.removeMonitor(monitor);
            fixture.delete();
        }
    }
}
