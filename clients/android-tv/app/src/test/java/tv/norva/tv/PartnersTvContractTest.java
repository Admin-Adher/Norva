package tv.norva.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PartnersTvContractTest {

    private static final String TOKEN =
            "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA."
                    + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String HANDOFF =
            "https://norva.tv/app.html#relay=" + TOKEN;

    @Test
    public void relayTokenAndHandoffAreExactAndOriginBound() {
        assertTrue(PartnersTvContract.isValidRelayToken(TOKEN));
        assertTrue(PartnersTvContract.isValidHandoffUrl(HANDOFF, TOKEN));

        assertFalse(PartnersTvContract.isValidRelayToken(TOKEN + "x"));
        assertFalse(PartnersTvContract.isValidRelayToken(TOKEN.replaceFirst("a", "A")));
        assertFalse(PartnersTvContract.isValidHandoffUrl(
                "https://evil.example/app.html#relay=" + TOKEN, TOKEN));
        assertFalse(PartnersTvContract.isValidHandoffUrl(
                "https://attacker@norva.tv/app.html#relay=" + TOKEN, TOKEN));
        assertFalse(PartnersTvContract.isValidHandoffUrl(
                "https://norva.tv/app.html?token=1#relay=" + TOKEN, TOKEN));
        assertFalse(PartnersTvContract.isValidHandoffUrl(
                "https://norva.tv/app.html#relay=" + TOKEN,
                "v1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB."
                        + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
    }

    @Test
    public void pendingRelayRequiresShortFutureExpiryAndBoundedPolling() {
        long now = 1_800_000_000_000L;
        assertTrue(PartnersTvContract.isValidPendingRelay(
                TOKEN, HANDOFF, now + 5L * 60L * 1000L, now, 3));

        assertFalse(PartnersTvContract.isValidPendingRelay(
                TOKEN, HANDOFF, now, now, 3));
        assertFalse(PartnersTvContract.isValidPendingRelay(
                TOKEN, HANDOFF, now + 11L * 60L * 1000L, now, 3));
        assertFalse(PartnersTvContract.isValidPendingRelay(
                TOKEN, HANDOFF, now + 5L * 60L * 1000L, now, 1));
        assertFalse(PartnersTvContract.isValidPendingRelay(
                TOKEN, HANDOFF, now + 5L * 60L * 1000L, now, 11));
    }

    @Test
    public void relayStateCannotRegressAfterTerminalResult() {
        assertTrue(PartnersTvContract.isValidRelayTransition(
                PartnersTvContract.RelayState.PENDING,
                PartnersTvContract.RelayState.CONSUMED));
        assertTrue(PartnersTvContract.isValidRelayTransition(
                PartnersTvContract.RelayState.PENDING,
                PartnersTvContract.RelayState.EXPIRED));
        assertTrue(PartnersTvContract.isValidRelayTransition(
                PartnersTvContract.RelayState.CONSUMED,
                PartnersTvContract.RelayState.CONSUMED));

        assertFalse(PartnersTvContract.isValidRelayTransition(
                PartnersTvContract.RelayState.CONSUMED,
                PartnersTvContract.RelayState.PENDING));
        assertFalse(PartnersTvContract.isValidRelayTransition(
                PartnersTvContract.RelayState.EXPIRED,
                PartnersTvContract.RelayState.CONSUMED));
    }

    @Test
    public void eachRelayStateHasTheProductSpecifiedInitialFocus() {
        assertEquals(
                PartnersTvContract.FocusTarget.CHECK_CONNECTION,
                PartnersTvContract.initialFocus(PartnersTvContract.RelayState.PENDING));
        assertEquals(
                PartnersTvContract.FocusTarget.BACK,
                PartnersTvContract.initialFocus(PartnersTvContract.RelayState.CONSUMED));
        assertEquals(
                PartnersTvContract.FocusTarget.NEW_RELAY,
                PartnersTvContract.initialFocus(PartnersTvContract.RelayState.EXPIRED));
    }

    @Test
    public void dpadLeftAndRightWrapWithoutEscapingTheActionRow() {
        assertEquals(1, PartnersTvContract.nextHorizontalIndex(0, 3, 1));
        assertEquals(0, PartnersTvContract.nextHorizontalIndex(2, 3, 1));
        assertEquals(2, PartnersTvContract.nextHorizontalIndex(0, 3, -1));
        assertEquals(1, PartnersTvContract.nextHorizontalIndex(2, 3, -1));
        assertEquals(1, PartnersTvContract.nextHorizontalIndex(0, 2, -1));

        assertEquals(-1, PartnersTvContract.nextHorizontalIndex(0, 0, 1));
        assertEquals(-1, PartnersTvContract.nextHorizontalIndex(0, 2, 0));
    }

    @Test
    public void norvaCloudTrustRejectsLookalikeAndUserInfoOrigins() {
        assertTrue(PartnersTvContract.isTrustedNorvaCloudUrl(
                "https://norva.tv:443/app.html#partners"));
        assertFalse(PartnersTvContract.isTrustedNorvaCloudUrl(
                "http://norva.tv/app.html#partners"));
        assertFalse(PartnersTvContract.isTrustedNorvaCloudUrl(
                "https://norva.tv.evil.example/app.html#partners"));
        assertFalse(PartnersTvContract.isTrustedNorvaCloudUrl(
                "https://attacker@norva.tv/app.html#partners"));
        assertFalse(PartnersTvContract.isTrustedNorvaCloudUrl(
                "https://norva.tv:444/app.html#partners"));
    }
}
