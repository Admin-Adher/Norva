package tv.norva.phone;

import org.junit.Test;
import static org.junit.Assert.*;

public final class MovieVersionRecoveryPolicyTest {
    @Test public void onlyExplicitOnlineMovieTerminalWithBridgeCanOfferCatalogueRecovery() {
        assertTrue(MovieVersionRecoveryPolicy.canOffer(true, false, "movie", "source", "file", true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(false, false, "movie", "source", "file", true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, true, "movie", "source", "file", true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, false, "episode", "source", "file", true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, false, "channel", "source", "file", true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, false, "movie", "source", "file", false, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, false, "movie", "source", "file", true, true));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, false, "movie", null, "file", true, false));
        assertFalse(MovieVersionRecoveryPolicy.canOffer(true, false, "movie", "source", " ", true, false));
    }
}
