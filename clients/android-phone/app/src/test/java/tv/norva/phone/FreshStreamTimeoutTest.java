package tv.norva.phone;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class FreshStreamTimeoutTest {
    @Test public void onlineResolverTimeoutIsNotReportedAsDeviceOffline() {
        assertEquals(PlayerActivity.PlaybackUiState.TERMINAL,
                PlayerActivity.stateForFreshStreamTimeout(false, false));
    }

    @Test public void actualConnectivityLossPreservesTheOfflineState() {
        assertEquals(PlayerActivity.PlaybackUiState.OFFLINE,
                PlayerActivity.stateForFreshStreamTimeout(false, true));
    }

    @Test public void formatFailureKeepsItsSpecificTerminalGuidance() {
        assertEquals(PlayerActivity.PlaybackUiState.TERMINAL,
                PlayerActivity.stateForFreshStreamTimeout(true, false));
        assertEquals(PlayerActivity.PlaybackUiState.TERMINAL,
                PlayerActivity.stateForFreshStreamTimeout(true, true));
    }
}
