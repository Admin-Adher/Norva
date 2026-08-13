package tv.norva.phone;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ProviderPlaybackPolicyTest {
    @Test
    public void firstProviderBusyStatusIsTerminal() {
        assertTrue(ProviderPlaybackPolicy.isProviderBusyHttpStatus(458));
        assertFalse(ProviderPlaybackPolicy.isProviderBusyHttpStatus(429));
        assertFalse(ProviderPlaybackPolicy.isProviderBusyHttpStatus(503));
    }

    @Test
    public void onlyExactSupersessionCodeStopsTheOldSession() {
        assertTrue(ProviderPlaybackPolicy.isPlaybackSuperseded("PLAYBACK_SUPERSEDED"));
        assertFalse(ProviderPlaybackPolicy.isPlaybackSuperseded("PLAYBACK_ERROR"));
        assertFalse(ProviderPlaybackPolicy.isPlaybackSuperseded(null));
    }
}
