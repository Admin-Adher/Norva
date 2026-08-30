package tv.norva.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class NativePlaybackClosePolicyTest {
    private static final String SESSION = "123e4567-e89b-42d3-a456-426614174000";
    private static final long CREATED_AT_MS = 1_700_000_000_000L;

    @Test
    public void persistenceRoundTripContainsOnlyUuidReasonAndAbsoluteAgeAnchor() {
        String encoded = NativePlaybackClosePolicy.encode(
                SESSION, "variant_change", CREATED_AT_MS);
        assertEquals(SESSION + "|variant_change|" + CREATED_AT_MS, encoded);

        NativePlaybackClosePolicy.Entry decoded = NativePlaybackClosePolicy.decode(
                encoded, CREATED_AT_MS + NativePlaybackClosePolicy.MAX_PENDING_AGE_MS - 1L);
        assertEquals(SESSION, decoded.sessionId);
        assertEquals("variant_change", decoded.reason);
        assertEquals(CREATED_AT_MS, decoded.createdAtEpochMs);
    }

    @Test
    public void malformedPersistenceAndUnboundedReasonsFailClosed() {
        assertNull(NativePlaybackClosePolicy.decode(
                "not-a-session|closed|" + CREATED_AT_MS, CREATED_AT_MS));
        assertNull(NativePlaybackClosePolicy.decode(
                SESSION + "|unknown|" + CREATED_AT_MS, CREATED_AT_MS));
        assertNull(NativePlaybackClosePolicy.decode(
                SESSION + "|closed|secret", CREATED_AT_MS));
        assertEquals("closed", NativePlaybackClosePolicy.boundedReason("unknown"));
        assertEquals("closed", NativePlaybackClosePolicy.boundedReason(null));
    }

    @Test
    public void durableAgeExpiresAtTwelveHoursAndCannotResetOnReload() {
        String encoded = NativePlaybackClosePolicy.encode(SESSION, "closed", CREATED_AT_MS);
        assertNull(NativePlaybackClosePolicy.decode(
                encoded, CREATED_AT_MS + NativePlaybackClosePolicy.MAX_PENDING_AGE_MS));
        assertNull(NativePlaybackClosePolicy.decode(encoded, CREATED_AT_MS - 1L));
        assertNull(NativePlaybackClosePolicy.encode(SESSION, "closed", 0L));
    }

    @Test
    public void acceptedRetriesWaitForAckAndAllDeliveryRetriesAreFinite() {
        assertEquals(500L, NativePlaybackClosePolicy.retryDelayMs(1, "not_ready"));
        assertEquals(13_000L, NativePlaybackClosePolicy.retryDelayMs(1, "accepted"));
        assertEquals(30_000L, NativePlaybackClosePolicy.retryDelayMs(2, "accepted"));
        assertEquals(-1L, NativePlaybackClosePolicy.retryDelayMs(
                NativePlaybackClosePolicy.MAX_DELIVERY_ATTEMPTS, "accepted"));
        assertEquals(-1L, NativePlaybackClosePolicy.retryDelayMs(
                NativePlaybackClosePolicy.MAX_DELIVERY_ATTEMPTS, "not_ready"));
    }
}
