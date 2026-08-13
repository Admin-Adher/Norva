package tv.norva.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.widget.TextView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.lang.reflect.Method;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

/** Emulator gate for the explicit server-side invalid-session terminal state. */
@RunWith(AndroidJUnit4.class)
public final class PlaybackSessionInvalidInstrumentedTest {
    @Test
    public void invalidSessionStopsPlaybackAnnouncesErrorAndBackCloses() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        AtomicReference<Activity> activityRef = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor =
                instrumentation.addMonitor(PlayerActivity.class.getName(), null, false);

        try {
            Intent launch = new Intent(target, PlayerActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(PlayerActivity.EXTRA_URL, "http://127.0.0.1:9/session-check.mp4")
                    .putExtra(PlayerActivity.EXTRA_TITLE, "Norva invalid session gate")
                    .putExtra(PlayerActivity.EXTRA_ITEM_TYPE, "movie")
                    .putExtra(PlayerActivity.EXTRA_ITEM_ID, "invalid-session-fixture")
                    .putExtra(PlayerActivity.EXTRA_PLAYBACK_SESSION_ID,
                            UUID.randomUUID().toString());
            target.startActivity(launch);
            Activity activity = instrumentation.waitForMonitorWithTimeout(monitor, 5_000L);
            activityRef.set(activity);
            assertNotNull(activity);

            Method showInvalid = PlayerActivity.class.getDeclaredMethod(
                    "showPlaybackSessionInvalid");
            showInvalid.setAccessible(true);
            AtomicReference<Throwable> invocationFailure = new AtomicReference<>();
            instrumentation.runOnMainSync(() -> {
                try {
                    showInvalid.invoke(activity);
                } catch (Throwable error) {
                    invocationFailure.set(error);
                }
            });
            if (invocationFailure.get() != null) {
                throw new AssertionError(invocationFailure.get());
            }

            TextView title = activity.findViewById(R.id.norva_tv_player_error_title);
            TextView message = activity.findViewById(R.id.norva_tv_player_error_message);
            assertNotNull(title);
            assertNotNull(message);
            assertEquals(target.getString(R.string.player_error_session_invalid_title),
                    title.getText().toString());
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE,
                    message.getAccessibilityLiveRegion());
            assertNotNull(activity.getCurrentFocus());
            assertEquals(R.id.norva_tv_player_retry_button, activity.getCurrentFocus().getId());

            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
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
}
