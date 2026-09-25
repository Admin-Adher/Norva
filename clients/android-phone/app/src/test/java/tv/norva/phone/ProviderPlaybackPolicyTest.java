package tv.norva.phone;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ProviderPlaybackPolicyTest {
    @Test public void startupRefusalResolvesOnceButHealthyLiveAndOfflineKeepTheirPolicy() {
        String[] refused = {"ERROR_CODE_IO_BAD_HTTP_STATUS", "ERROR_CODE_IO_NETWORK_CONNECTION_FAILED",
                "ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT", "ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED", "no_data_timeout"};
        for (String reason : refused) {
            assertTrue(ProviderPlaybackPolicy.refreshUnprovenVodRoute(reason, false, false, true));
            assertFalse(ProviderPlaybackPolicy.refreshUnprovenVodRoute(reason, true, false, true));
            assertFalse(ProviderPlaybackPolicy.refreshUnprovenVodRoute(reason, false, true, true));
            assertFalse(ProviderPlaybackPolicy.refreshUnprovenVodRoute(reason, false, false, false));
        }
        assertFalse(ProviderPlaybackPolicy.refreshUnprovenVodRoute("provider_busy", false, false, true));
        assertFalse(ProviderPlaybackPolicy.refreshUnprovenVodRoute("ERROR_CODE_DECODING_FAILED", false, false, true));
    }
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
