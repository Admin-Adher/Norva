package tv.norva.playback;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.PlaybackException;
import org.junit.Test;

public final class NativeLiveWindowRecoveryTest {
    private static final String URL = "https://epg.provider.plex.tv/library/parts/"
            + "643054b1fc3be59477853717-68a799722895f21006e758e4/?X-Plex-Token=test";

    @Test public void repeatedWindowFailuresCannotCreateARecoveryLoop() {
        NativeLiveWindowRecovery recovery = new NativeLiveWindowRecovery();
        assertTrue(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW, URL, "live"));
        for (int i = 0; i < 20; i++) {
            assertFalse(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW, URL, "live"));
        }
        recovery.reset();
        assertTrue(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW, URL, "channel"));
    }

    @Test public void otherFailuresAndSourcesKeepTheirExistingRecovery() {
        NativeLiveWindowRecovery recovery = new NativeLiveWindowRecovery();
        for (int code : new int[]{PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
                PlaybackException.ERROR_CODE_DECODING_FAILED,
                PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED}) {
            assertFalse(recovery.tryAcquire(code, URL, "live"));
        }
        assertFalse(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW, URL, "movie"));
        assertFalse(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW,
                "https://media.norva.tv/sessions/test/index.m3u8", "live"));
        assertFalse(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW,
                URL.replace("plex.tv", "plex.tv.evil.test"), "live"));
        // Ignored errors must not consume the one eligible recovery.
        assertTrue(recovery.tryAcquire(PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW, URL, "live"));
    }
}
