package tv.norva.phone;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure validation rules for the native Norva Partners boundary.
 *
 * <p>This class deliberately has no Android dependency. The Activity remains
 * responsible for Intents and WebView calls, while these security-sensitive
 * rules can run as ordinary JVM unit tests.</p>
 */
final class PartnersContract {

    static final int SHARE_PROTOCOL_VERSION = 1;
    static final int MAX_SHARE_MESSAGE_CHARS = 4_096;
    static final int MAX_SHARE_TEXT_CHARS = 500;
    static final int MAX_DISCLOSURE_CHARS = 300;
    static final int MAX_CHOOSER_TITLE_CHARS = 80;

    private static final String NORVA_ORIGIN = "https://norva.tv";
    private static final String CLOUD_WATCH_URL = NORVA_ORIGIN + "/app.html?mobile=1";
    private static final Pattern REFERRAL_PATH =
            Pattern.compile("^/r/([A-Za-z0-9_-]{32})/?$");
    private static final Pattern RELAY_FRAGMENT =
            Pattern.compile("^relay=v1\\.[A-Za-z0-9_-]{43}\\.[0-9a-f]{64}$");
    private static final Pattern REQUEST_ID =
            Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$");
    private static final Set<String> PAYOUT_PROVIDERS = new HashSet<>(
            Arrays.asList("wise", "revolut", "stripe_connect"));
    private static final Set<String> ACCOUNT_STATUSES = new HashSet<>(
            Arrays.asList(
                    "invited",
                    "pending_verification",
                    "active",
                    "held",
                    "suspended",
                    "closed"));
    private static final Set<String> FISCAL_STATUSES = new HashSet<>(
            Arrays.asList("missing", "pending", "verified", "rejected", "expired"));
    private static final Set<String> PAYOUT_PROFILE_STATUSES = new HashSet<>(
            Arrays.asList("active", "disabled", "verification_required"));
    private static final Set<String> PAYOUT_READINESS_REASONS = new HashSet<>(
            Arrays.asList(
                    "account_not_active",
                    "kyc_not_verified",
                    "fiscal_profile_required",
                    "provider_not_configured",
                    "payouts_not_live"));

    private PartnersContract() {}

    static boolean isOpaqueReferralCode(String code) {
        return code != null && code.matches("^[A-Za-z0-9_-]{32}$");
    }

    static String canonicalReferralDestination(String value) {
        String code = referralCode(value);
        return code == null ? null : NORVA_ORIGIN + "/r/" + code + "?mobile=1";
    }

    static String canonicalShareReferralUrl(String value) {
        String code = referralCode(value);
        return code == null ? null : NORVA_ORIGIN + "/r/" + code;
    }

    private static String referralCode(String value) {
        URI uri = safeHttpsNorvaUri(value);
        if (uri == null || value.length() > MAX_SHARE_MESSAGE_CHARS) return null;
        String path = uri.getRawPath();
        if (path == null || path.indexOf('%') >= 0) return null;
        Matcher matcher = REFERRAL_PATH.matcher(path);
        return matcher.matches() && isOpaqueReferralCode(matcher.group(1))
                ? matcher.group(1)
                : null;
    }

    static String canonicalRelayDestination(String value) {
        URI uri = safeHttpsNorvaUri(value);
        if (uri == null
                || value.length() > MAX_SHARE_MESSAGE_CHARS
                || !"/app.html".equals(uri.getRawPath())
                || uri.getRawQuery() != null) {
            return null;
        }
        String fragment = uri.getRawFragment();
        if (fragment == null || !RELAY_FRAGMENT.matcher(fragment).matches()) return null;
        return CLOUD_WATCH_URL + "#" + fragment;
    }

    static String canonicalKycReturnDestination(String value) {
        URI uri = safeHttpsNorvaUri(value);
        if (uri == null
                || value.length() > MAX_SHARE_MESSAGE_CHARS
                || !"/partners-kyc-return".equals(uri.getRawPath())) {
            return null;
        }
        // Didit may append provider-controlled query values. They are never
        // copied into WebView history; the Norva callback needs only the path.
        return NORVA_ORIGIN + "/partners-kyc-return";
    }

    static boolean isTrustedPartnersPage(String value) {
        URI uri = safeHttpsNorvaUri(value);
        if (uri == null) return false;
        String path = uri.getRawPath();
        if (!("/app.html".equals(path) || "/app".equals(path))) return false;
        String fragment = uri.getRawFragment();
        if (fragment == null) return false;
        int slash = fragment.indexOf('/');
        String route = slash < 0 ? fragment : fragment.substring(0, slash);
        return "partners".equals(route);
    }

    static boolean isValidShareRequestId(String requestId) {
        return requestId != null && REQUEST_ID.matcher(requestId).matches();
    }

    static String strictShareText(String value, int maxLength) {
        if (value == null
                || maxLength <= 0
                || value.isEmpty()
                || value.length() > maxLength
                || !value.equals(value.trim())) {
            return null;
        }
        for (int index = 0; index < value.length(); index += 1) {
            if (Character.isISOControl(value.charAt(index))) return null;
        }
        return value;
    }

    static String buildShareText(
            String referralUrl,
            String message,
            String disclosure,
            String chooserTitle) {
        String url = canonicalShareReferralUrl(referralUrl);
        String safeMessage = strictShareText(message, MAX_SHARE_TEXT_CHARS);
        String safeDisclosure = strictShareText(disclosure, MAX_DISCLOSURE_CHARS);
        String safeTitle = strictShareText(chooserTitle, MAX_CHOOSER_TITLE_CHARS);
        if (url == null
                || safeMessage == null
                || safeDisclosure == null
                || safeTitle == null) {
            return null;
        }
        return safeMessage + "\n\n" + safeDisclosure + "\n" + url;
    }

    /**
     * Native QR export stays disabled until Android can verify that the pixels
     * encode the already-validated referral URL.
     */
    static boolean canExportReferralQr() {
        return false;
    }

    /**
     * Android Back must close the Partners QR sheet before the SPA changes
     * history. The sheet is intentionally not a generic Norva modal, so the
     * native shell performs this one narrow preflight and then delegates every
     * other state to the existing web Back handler.
     */
    static String nativeBackScript() {
        return "(function(){try{"
                + "var q=document.querySelector('[data-partners-qr-overlay]');"
                + "if(q&&typeof q.__regionClose==='function'){"
                + "q.__regionClose();return 'handled';}"
                + "return window.__norvaHandleBack"
                + "?window.__norvaHandleBack():'none';"
                + "}catch(e){return 'none';}})()";
    }

    static boolean isSafeTokenizedPayoutProfile(
            String provider,
            String beneficiaryTokenRef,
            String displayMasked,
            String currency) {
        if (!PAYOUT_PROVIDERS.contains(provider)
                || beneficiaryTokenRef == null
                || beneficiaryTokenRef.length() < 8
                || beneficiaryTokenRef.length() > 255
                || containsWhitespaceOrControl(beneficiaryTokenRef)
                || looksLikeRawPayoutIdentifier(beneficiaryTokenRef)
                || displayMasked == null
                || displayMasked.length() < 4
                || displayMasked.length() > 64
                || !displayMasked.equals(displayMasked.trim())
                || containsControl(displayMasked)
                || looksLikeRawPayoutIdentifier(displayMasked)
                || currency == null
                || !currency.matches("^[A-Z]{3}$")) {
            return false;
        }
        return true;
    }

    static boolean isConsistentPayoutReadinessMessage(
            String accountStatus,
            String fiscalStatus,
            String profileStatus,
            boolean payoutsLive,
            String reason,
            boolean ready) {
        if (!ACCOUNT_STATUSES.contains(accountStatus)
                || (fiscalStatus != null && !FISCAL_STATUSES.contains(fiscalStatus))
                || (profileStatus != null
                    && !PAYOUT_PROFILE_STATUSES.contains(profileStatus))
                || (reason != null && !PAYOUT_READINESS_REASONS.contains(reason))) {
            return false;
        }
        boolean expected = reason == null
                && payoutsLive
                && "active".equals(accountStatus)
                && "verified".equals(fiscalStatus)
                && "active".equals(profileStatus);
        return ready == expected;
    }

    private static URI safeHttpsNorvaUri(String value) {
        if (value == null || value.isEmpty()) return null;
        try {
            URI uri = new URI(value);
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !"norva.tv".equalsIgnoreCase(uri.getHost())
                    || (uri.getPort() != -1 && uri.getPort() != 443)
                    || uri.getRawUserInfo() != null) {
                return null;
            }
            return uri;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean containsWhitespaceOrControl(String value) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (Character.isWhitespace(character) || Character.isISOControl(character)) {
                return true;
            }
        }
        return false;
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index += 1) {
            if (Character.isISOControl(value.charAt(index))) return true;
        }
        return false;
    }

    private static boolean looksLikeRawPayoutIdentifier(String value) {
        String text = value == null ? "" : value;
        String compact = text.replace("-", "")
                .replace(" ", "")
                .toUpperCase(Locale.ROOT);
        String digits = text.replaceAll("[-:/. ]", "");
        return compact.matches("^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$")
                || digits.matches("^\\d{6,34}$")
                || text.matches("^[^@\\s]+@[^@\\s]+$");
    }
}
