package tv.norva.playback;

import static org.junit.Assert.*;
import org.junit.Test;

public final class NativeVodStartupProgressTest {
    @Test public void slowActiveIndexReadDoesNotRestartAfterThirtyFiveSeconds() {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        long route = progress.begin(0);
        for (long now = 5000; now <= 80000; now += 5000) {
            progress.bytesRead(route, 8192, now);
            assertEquals(NativeVodStartupProgress.Decision.WAIT, progress.decision(now));
            assertTrue(progress.mayRenewLease(now));
            assertTrue(progress.nextCheckMs(now) > 0);
        }
        progress.rendered(); // Actual first frame ends the startup budget.
        assertEquals(NativeVodStartupProgress.Decision.STOPPED, progress.decision(81000));
    }

    @Test public void noBytesOrAStalledReadRetainTheExistingIdleDeadline() {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        long route = progress.begin(100);
        progress.bytesRead(route, 0, 30000);
        progress.bytesRead(route, -1, 34000);
        assertEquals(NativeVodStartupProgress.Decision.IDLE_TIMEOUT, progress.decision(35100));
        assertFalse(progress.mayRenewLease(35100));
        route = progress.begin(40000);
        progress.bytesRead(route, 1024, 50000);
        assertEquals(NativeVodStartupProgress.Decision.WAIT, progress.decision(84999));
        assertEquals(1L, progress.nextCheckMs(84999));
        assertEquals(NativeVodStartupProgress.Decision.IDLE_TIMEOUT, progress.decision(85000));
    }

    @Test public void evenContinuousTricklesReachTheAbsoluteTerminalBudget() {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        long route = progress.begin(0);
        for (long now = 10000; now <= 120000; now += 10000) progress.bytesRead(route, 1, now);
        assertEquals(NativeVodStartupProgress.Decision.STARTUP_LIMIT, progress.decision(120000));
        assertFalse(progress.mayRenewLease(120000));
    }

    @Test public void lateReadsCannotRenewAStoppedOrNewRoute() {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        long old = progress.begin(0);
        progress.stop(); // Back, terminal or background.
        progress.bytesRead(old, 1000, 30000);
        assertFalse(progress.active());
        assertFalse(progress.mayRenewLease(30000));
        long current = progress.begin(40000); // Explicit retry / foreground.
        progress.bytesRead(old, 1000, 70000);
        assertEquals(NativeVodStartupProgress.Decision.IDLE_TIMEOUT, progress.decision(75000));
        progress.bytesRead(current, 1000, 76000);
        assertEquals(NativeVodStartupProgress.Decision.WAIT, progress.decision(76000));
    }

    @Test public void renderedRouteAllowsSeeksUntilItIsActuallyCancelled() {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        long route = progress.begin(0);
        int[] closed = {0};
        Runnable reader = () -> closed[0]++;
        assertTrue(progress.attachReader(route, reader));
        progress.rendered();
        assertEquals(0, closed[0]);
        assertFalse(progress.active());
        progress.detachReader(reader);
        assertTrue(progress.attachReader(route, reader));
        progress.stop();
        progress.stop();
        assertEquals(1, closed[0]);
        assertFalse(progress.attachReader(route, reader));
    }

    @Test public void successorCancelsOnlyPreviousReadersAndRejectsLateAttachment() {
        NativeVodStartupProgress progress = new NativeVodStartupProgress();
        long previous = progress.begin(0);
        int[] closed = {0};
        Runnable reader = () -> closed[0]++;
        assertTrue(progress.attachReader(previous, reader));
        long current = progress.begin(10);
        assertEquals(1, closed[0]);
        assertFalse(progress.attachReader(previous, reader));
        assertTrue(progress.attachReader(current, reader));
        progress.detachReader(reader);
        progress.stop();
        assertEquals(1, closed[0]);
    }
}
