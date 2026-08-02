package tv.norva.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class PartnersContractTest {

    private static final String CODE = "AbCdEf0123456789_-AbCdEf01234567";
    private static final String RELAY_TOKEN =
            "v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA."
                    + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    @Test
    public void referralAppLinkCanonicalizesOnlyTheExactNorvaRoute() {
        assertEquals(
                "https://norva.tv/r/" + CODE + "?mobile=1",
                PartnersContract.canonicalReferralDestination(
                        "https://NORVA.tv:443/r/" + CODE + "?utm_source=x#ignored"));
        assertEquals(
                "https://norva.tv/r/" + CODE,
                PartnersContract.canonicalShareReferralUrl(
                        "https://norva.tv/r/" + CODE + "?mobile=1"));

        assertNull(PartnersContract.canonicalReferralDestination(
                "http://norva.tv/r/" + CODE));
        assertNull(PartnersContract.canonicalReferralDestination(
                "https://norva.tv.evil.example/r/" + CODE));
        assertNull(PartnersContract.canonicalReferralDestination(
                "https://attacker@norva.tv/r/" + CODE));
        assertNull(PartnersContract.canonicalReferralDestination(
                "https://norva.tv/r/%41" + CODE.substring(1)));
        assertNull(PartnersContract.canonicalReferralDestination(
                "https://norva.tv/r/" + CODE + "/extra"));
        assertNull(PartnersContract.canonicalReferralDestination(
                "https://norva.tv/r/" + CODE.substring(1)));
    }

    @Test
    public void tvRelayAppLinkAcceptsOneBoundedBearerFragment() {
        String input = "https://norva.tv/app.html#relay=" + RELAY_TOKEN;
        assertEquals(
                "https://norva.tv/app.html?mobile=1#relay=" + RELAY_TOKEN,
                PartnersContract.canonicalRelayDestination(input));

        assertNull(PartnersContract.canonicalRelayDestination(
                "https://norva.tv/app.html?relay=1#relay=" + RELAY_TOKEN));
        assertNull(PartnersContract.canonicalRelayDestination(
                "https://norva.tv/app#relay=" + RELAY_TOKEN));
        assertNull(PartnersContract.canonicalRelayDestination(
                "https://evil.example/app.html#relay=" + RELAY_TOKEN));
        assertNull(PartnersContract.canonicalRelayDestination(
                "https://norva.tv/app.html#relay="
                        + RELAY_TOKEN.replaceFirst("a", "A")));
        assertNull(PartnersContract.canonicalRelayDestination(
                "https://norva.tv/app.html#relay=" + RELAY_TOKEN + ".extra"));
    }

    @Test
    public void diditReturnStripsProviderControlledParametersBeforeWebView() {
        assertEquals(
                "https://norva.tv/partners-kyc-return",
                PartnersContract.canonicalKycReturnDestination(
                        "https://norva.tv/partners-kyc-return?status=approved&verificationSessionId=secret#ignored"));
        assertNull(PartnersContract.canonicalKycReturnDestination(
                "https://norva.tv.evil.example/partners-kyc-return?status=approved"));
        assertNull(PartnersContract.canonicalKycReturnDestination(
                "http://norva.tv/partners-kyc-return"));
        assertNull(PartnersContract.canonicalKycReturnDestination(
                "https://norva.tv/partners-kyc-return/extra"));
    }

    @Test
    public void partnersPageTrustIsOriginPathAndRouteBound() {
        assertTrue(PartnersContract.isTrustedPartnersPage(
                "https://norva.tv/app.html?mobile=1#partners"));
        assertTrue(PartnersContract.isTrustedPartnersPage(
                "https://norva.tv/app#partners/history"));
        assertFalse(PartnersContract.isTrustedPartnersPage(
                "https://norva.tv/app.html#home"));
        assertFalse(PartnersContract.isTrustedPartnersPage(
                "https://norva.tv.evil.example/app.html#partners"));
        assertFalse(PartnersContract.isTrustedPartnersPage(
                "https://norva.tv/landing.html#partners"));
    }

    @Test
    public void shareMessageKeepsDisclosureAndCanonicalUrlIndivisible() {
        String share = PartnersContract.buildShareText(
                "https://norva.tv/r/" + CODE + "?mobile=1",
                "Try Norva on every screen.",
                "I may earn a commission if you subscribe.",
                "Share Norva");
        assertEquals(
                "Try Norva on every screen.\n\n"
                        + "I may earn a commission if you subscribe.\n"
                        + "https://norva.tv/r/" + CODE,
                share);
        assertTrue(PartnersContract.isValidShareRequestId("share_01.valid-id"));
        assertFalse(PartnersContract.isValidShareRequestId(""));
        assertFalse(PartnersContract.isValidShareRequestId("-starts-with-symbol"));
        assertFalse(PartnersContract.isValidShareRequestId(repeat('a', 81)));

        assertNull(PartnersContract.buildShareText(
                "https://evil.example/r/" + CODE,
                "Try Norva",
                "Commission disclosure",
                "Share Norva"));
        assertNull(PartnersContract.buildShareText(
                "https://norva.tv/r/" + CODE,
                " Try Norva",
                "Commission disclosure",
                "Share Norva"));
        assertNull(PartnersContract.buildShareText(
                "https://norva.tv/r/" + CODE,
                "Try\nNorva",
                "Commission disclosure",
                "Share Norva"));
    }

    @Test
    public void qrExportRemainsFailClosedWithoutSemanticPixelValidation() {
        assertFalse(PartnersContract.canExportReferralQr());
    }

    @Test
    public void androidBackClosesThePartnersQrBeforeDelegatingToSpaHistory() {
        String script = PartnersContract.nativeBackScript();
        int qrSelector = script.indexOf("[data-partners-qr-overlay]");
        int qrClose = script.indexOf("q.__regionClose()");
        int handled = script.indexOf("return 'handled'");
        int genericBack = script.indexOf("window.__norvaHandleBack()");

        assertTrue(qrSelector >= 0);
        assertTrue(qrClose > qrSelector);
        assertTrue(handled > qrClose);
        assertTrue(genericBack > handled);
        assertFalse(script.contains("innerHTML"));
        assertFalse(script.contains("localStorage"));
    }

    @Test
    public void payoutMessagesAllowOnlyOpaqueProviderTokensAndMaskedDisplay() {
        assertTrue(PartnersContract.isSafeTokenizedPayoutProfile(
                "wise",
                "ben_tok_8f6b54a9021c",
                "Account ending 4821",
                "EUR"));

        assertFalse(PartnersContract.isSafeTokenizedPayoutProfile(
                "wise",
                "FR7630006000011234567890189",
                "Account ending 0189",
                "EUR"));
        assertFalse(PartnersContract.isSafeTokenizedPayoutProfile(
                "revolut",
                "user@example.com",
                "user@example.com",
                "EUR"));
        assertFalse(PartnersContract.isSafeTokenizedPayoutProfile(
                "stripe_connect",
                "acct token with spaces",
                "Account ending 4821",
                "USD"));
        assertFalse(PartnersContract.isSafeTokenizedPayoutProfile(
                "unknown_provider",
                "ben_tok_8f6b54a9021c",
                "Account ending 4821",
                "USD"));
    }

    @Test
    public void payoutReadinessCannotClaimReadyFromPartialState() {
        assertTrue(PartnersContract.isConsistentPayoutReadinessMessage(
                "active", "verified", "active", true, null, true));
        assertTrue(PartnersContract.isConsistentPayoutReadinessMessage(
                "active", "verified", "active", false, "payouts_not_live", false));

        assertFalse(PartnersContract.isConsistentPayoutReadinessMessage(
                "active", "pending", "active", true, null, true));
        assertFalse(PartnersContract.isConsistentPayoutReadinessMessage(
                "active", "verified", "active", true, "provider_not_configured", true));
        assertFalse(PartnersContract.isConsistentPayoutReadinessMessage(
                "unknown", "verified", "active", true, null, true));
    }

    private static String repeat(char value, int count) {
        StringBuilder result = new StringBuilder(count);
        for (int index = 0; index < count; index += 1) result.append(value);
        return result.toString();
    }
}
