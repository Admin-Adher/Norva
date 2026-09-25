package tv.norva.phone;

import org.junit.Test;
import static org.junit.Assert.assertEquals;

public final class ResumeRecoveryPositionTest {
    @Test public void refusalBeforeReadyKeepsTheCrossDeviceResumePoint() {
        long position = 300_000L;
        for (int attempt = 0; attempt < 4; attempt++) {
            position = PlayerActivity.recoveryPositionMs(false, 0L, position, -9223372036854775807L);
            assertEquals(300_000L, position);
        }
    }

    @Test public void aReplacementRouteKeepsTheLastPlayedPosition() {
        long position = PlayerActivity.recoveryPositionMs(true, 481_500L, 300_000L, 6_000_000L);
        assertEquals(481_500L, position);
        assertEquals(position, PlayerActivity.recoveryPositionMs(false, 0L, position, -1L));
    }

    @Test public void anExplicitRewindToZeroAfterAFrameIsNotUndone() {
        assertEquals(0L, PlayerActivity.recoveryPositionMs(true, 0L, 300_000L, 6_000_000L));
        assertEquals(125_000L, PlayerActivity.recoveryPositionMs(true, 125_000L, 300_000L, 6_000_000L));
    }

    @Test public void aKnownShorterDurationBoundsTheRestoredPosition() {
        assertEquals(59_000L, PlayerActivity.recoveryPositionMs(false, 0L, 300_000L, 60_000L));
        assertEquals(0L, PlayerActivity.recoveryPositionMs(false, -1L, -1L, -1L));
    }
}
