package tv.norva.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/** Runtime contract for the native Downloads surface on a real phone emulator. */
@RunWith(AndroidJUnit4.class)
public final class DownloadsActivityInstrumentedTest {

    @Test
    public void controlsAreSemanticAndStayAboveSystemNavigation() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context target = instrumentation.getTargetContext();
        Instrumentation.ActivityMonitor monitor =
                instrumentation.addMonitor(DownloadsActivity.class.getName(), null, false);
        Activity activity = null;
        try {
            target.startActivity(new Intent(target, DownloadsActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            // API 35 emulator cold-start class verification can exceed five
            // seconds even though the Activity is launching normally.
            activity = instrumentation.waitForMonitorWithTimeout(monitor, 15_000);
            assertNotNull("DownloadsActivity did not launch", activity);

            // Allow the first background manifest snapshot to bind.
            Thread.sleep(2_000);
            instrumentation.waitForIdleSync();

            AtomicReference<TextView> clearRef = new AtomicReference<>();
            AtomicReference<DownloadsActivity.Toggle> toggleRef = new AtomicReference<>();
            AtomicReference<ScrollView> scrollRef = new AtomicReference<>();
            Activity finalActivity = activity;
            String clearAllLabel = target.getString(R.string.downloads_clear_all);
            instrumentation.runOnMainSync(() -> {
                View root = finalActivity.findViewById(android.R.id.content);
                clearRef.set(findText(root, clearAllLabel));
                toggleRef.set(findFirst(root, DownloadsActivity.Toggle.class));
                scrollRef.set(findFirst(root, ScrollView.class));
            });

            TextView clear = clearRef.get();
            DownloadsActivity.Toggle toggle = toggleRef.get();
            ScrollView scroll = scrollRef.get();
            assertNotNull("Clear all action is missing", clear);
            assertNotNull("Wi-Fi semantic toggle is missing", toggle);
            assertNotNull("Downloads scroll root is missing", scroll);

            List<DownloadStore.Item> items = DownloadStore.all(target);
            assertEquals("Clear all enabled state is stale", !items.isEmpty(), clear.isEnabled());
            assertTrue("Clear all touch target is below 48 dp",
                    clear.getHeight() >= dp(target, 48));

            View row = (View) toggle.getParent();
            assertTrue("Toggle row must own click", row.isClickable());
            assertTrue("Toggle row must own focus", row.isFocusable());
            assertFalse("Painted toggle must not own click", toggle.isClickable());
            assertFalse("Painted toggle must not own focus", toggle.isFocusable());
            assertEquals(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO,
                    toggle.getImportantForAccessibility());
            AccessibilityNodeInfo node = row.createAccessibilityNodeInfo();
            assertEquals("android.widget.Switch", String.valueOf(node.getClassName()));
            assertTrue(node.isCheckable());

            if (Build.VERSION.SDK_INT >= 30) {
                View container = scroll.getChildAt(0);
                WindowInsets windowInsets = scroll.getRootWindowInsets();
                assertNotNull(windowInsets);
                Insets safe = windowInsets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                assertTrue(
                        "Bottom content can collide with Android navigation",
                        container.getPaddingBottom() >= dp(target, 24) + safe.bottom);
            }
        } finally {
            instrumentation.removeMonitor(monitor);
            if (activity != null) {
                Activity finalActivity = activity;
                instrumentation.runOnMainSync(finalActivity::finish);
            }
        }
    }

    private static TextView findText(View view, String text) {
        if (view instanceof TextView && text.contentEquals(((TextView) view).getText())) {
            return (TextView) view;
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                TextView match = findText(group.getChildAt(index), text);
                if (match != null) return match;
            }
        }
        return null;
    }

    private static <T extends View> T findFirst(View view, Class<T> type) {
        if (type.isInstance(view)) return type.cast(view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int index = 0; index < group.getChildCount(); index++) {
                T match = findFirst(group.getChildAt(index), type);
                if (match != null) return match;
            }
        }
        return null;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
