package tv.norva.tv;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MovieVersionRecoveryPolicyTest {
    private static final String SESSION = "00000000-0000-4000-8000-000000000001";

    @Test public void exactCloudMovieMayOfferUserChoiceAtTerminal() {
        assertTrue(MovieVersionRecoveryPolicy.canOffer(true, "movie", "source", "file", SESSION, true, false));
    }
    @Test public void loadingConflictOfflineAndUnsupportedLaunchStayExcluded() {
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, "movie", "source", "file", SESSION, false, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, "movie", "source", "file", SESSION, true, true));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(false, "movie", "source", "file", SESSION, true, false));
    }
    @Test public void liveEpisodeLocalAndMissingCoordinatesStayExcluded() {
        for (String type : new String[]{"live", "channel", "episode", "series", "download"})
            assertFalse(MovieVersionRecoveryPolicy.canOffer(true, type, "source", "file", SESSION, true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, "movie", "source", "file", null, true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, "movie", null, "file", SESSION, true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, "movie", "source", "https://private.invalid/file", SESSION, true, false));
    }
}
