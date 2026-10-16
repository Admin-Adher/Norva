package tv.norva.phone;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.webkit.WebView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.Assert.*;

/** Real system touches, after the attached WebView is ready for input. */
final class TouchTestSupport {
    static UiAutomation prepare(Instrumentation instrumentation, WebView view) throws Exception {
        // Connecting UiAutomation can change accessibility/window state. Do it
        // before measuring DOM coordinates, rather than during the first DOWN.
        UiAutomation automation = instrumentation.getUiAutomation();
        AtomicBoolean focused = new AtomicBoolean();
        long deadline = SystemClock.uptimeMillis() + 5000;
        do {
            instrumentation.runOnMainSync(() -> focused.set(view.isAttachedToWindow()
                && view.isShown() && view.hasWindowFocus()));
            if (!focused.get()) SystemClock.sleep(50);
        } while (!focused.get() && SystemClock.uptimeMillis() < deadline);
        assertTrue("Attached touch window has focus", focused.get());
        CountDownLatch presented = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> view.postVisualStateCallback(0, new WebView.VisualStateCallback() {
            @Override public void onComplete(long requestId) {
                view.postOnAnimation(() -> view.postOnAnimation(presented::countDown));
            }
        }));
        assertTrue("Touch target frame presented", presented.await(15, TimeUnit.SECONDS));
        instrumentation.waitForIdleSync();
        return automation;
    }

    static void tap(UiAutomation automation, float x, float y) {
        long down = SystemClock.uptimeMillis();
        boolean released = false;
        try {
            inject(automation, down, MotionEvent.ACTION_DOWN, x, y, true);
            SystemClock.sleep(50);
            inject(automation, down, MotionEvent.ACTION_UP, x, y, true);
            released = true;
        } finally {
            // A failed injection must stay failed, but must not leave a pressed
            // pointer in InputDispatcher for the next test. Never retry a tap.
            if (!released) {
                try { inject(automation, down, MotionEvent.ACTION_CANCEL, x, y, false); }
                catch (RuntimeException ignored) { }
            }
        }
    }

    private static void inject(UiAutomation automation, long down, int action,
                               float x, float y, boolean required) {
        MotionEvent event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            boolean delivered = automation.injectInputEvent(event, true);
            if (required) assertTrue("Search touch delivered (action " + action + ")", delivered);
        } finally { event.recycle(); }
    }
}
