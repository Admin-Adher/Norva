package tv.norva.tv;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PlaybackHeartbeatFailurePolicyTest {
    @Test
    public void supersessionAndExplicitInvalidSessionStopImmediately() {
        PlaybackHeartbeatFailurePolicy policy = new PlaybackHeartbeatFailurePolicy();

        assertEquals(
                PlaybackHeartbeatFailurePolicy.Decision.STOP_SUPERSEDED,
                policy.onResult("PLAYBACK_SUPERSEDED", 10_000L));

        for (String code : new String[]{
                "HTTP_400", "HTTP_401", "HTTP_403", "HTTP_404",
                "HTTP_409", "HTTP_410", "HTTP_422"
        }) {
            policy.reset();
            assertEquals(
                    code,
                    PlaybackHeartbeatFailurePolicy.Decision.STOP_SESSION_INVALID,
                    policy.onResult(code, 10_000L));
        }
    }

    @Test
    public void isolatedOrShortNetworkIncidentNeverStopsPlayback() {
        PlaybackHeartbeatFailurePolicy policy = new PlaybackHeartbeatFailurePolicy();

        assertEquals(
                PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 1_000L));
        assertEquals(
                PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("AUTH_UNAVAILABLE", 6_000L));
        assertEquals(
                PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("HTTP_503", 16_000L));
        assertEquals(
                PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 45_999L));
    }

    @Test
    public void persistentNetworkFailureStopsOnlyAfterCountAndTimeBudgets() {
        PlaybackHeartbeatFailurePolicy policy = new PlaybackHeartbeatFailurePolicy();

        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 1_000L));
        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 16_000L));
        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 31_000L));
        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 45_999L));
        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.STOP_NETWORK_UNVERIFIED,
                policy.onResult("NETWORK_ERROR", 46_000L));
    }

    @Test
    public void successfulHeartbeatFullyResetsTheFailureWindow() {
        PlaybackHeartbeatFailurePolicy policy = new PlaybackHeartbeatFailurePolicy();

        policy.onResult("NETWORK_ERROR", 1_000L);
        policy.onResult("NETWORK_ERROR", 20_000L);
        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("ok", 30_000L));
        assertEquals(PlaybackHeartbeatFailurePolicy.Decision.CONTINUE,
                policy.onResult("NETWORK_ERROR", 80_000L));
    }
}
