package tv.norva.tv;

import java.net.URI;
import java.util.regex.Pattern;

/**
 * Pure Norva Partners relay and focus rules for the Android TV shell.
 *
 * <p>The Partners screen itself remains in the TV WebView. Keeping its bearer
 * token and deterministic focus rules here gives the native project real JVM
 * coverage without introducing a second UI implementation.</p>
 */
final class PartnersTvContract {

    enum RelayState {
        PENDING,
        CONSUMED,
        EXPIRED
    }

    enum FocusTarget {
        CHECK_CONNECTION,
        NEW_RELAY,
        BACK
    }

    private static final Pattern RELAY_TOKEN =
            Pattern.compile("^v1\\.[A-Za-z0-9_-]{43}\\.[0-9a-f]{64}$");

    private PartnersTvContract() {}

    static boolean isTrustedNorvaCloudUrl(String value) {
        URI uri = safeUri(value);
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && "norva.tv".equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getRawUserInfo() == null;
    }

    static boolean isValidRelayToken(String value) {
        return value != null && RELAY_TOKEN.matcher(value).matches();
    }

    static boolean isValidHandoffUrl(String handoffUrl, String relayToken) {
        if (!isValidRelayToken(relayToken)
                || handoffUrl == null
                || handoffUrl.length() > 512) {
            return false;
        }
        URI uri = safeUri(handoffUrl);
        return uri != null
                && isTrustedNorvaCloudUrl(handoffUrl)
                && "/app.html".equals(uri.getRawPath())
                && uri.getRawQuery() == null
                && ("relay=" + relayToken).equals(uri.getRawFragment());
    }

    static boolean isValidPendingRelay(
            String relayToken,
            String handoffUrl,
            long expiresAtEpochMs,
            long nowEpochMs,
            int pollAfterSeconds) {
        return isValidHandoffUrl(handoffUrl, relayToken)
                && expiresAtEpochMs > nowEpochMs
                && expiresAtEpochMs - nowEpochMs <= 10L * 60L * 1000L
                && pollAfterSeconds >= 2
                && pollAfterSeconds <= 10;
    }

    static boolean isValidRelayTransition(RelayState previous, RelayState next) {
        if (previous == null || next == null) return false;
        if (previous == next) return true;
        return previous == RelayState.PENDING
                && (next == RelayState.CONSUMED || next == RelayState.EXPIRED);
    }

    /**
     * Mirrors the initial focus contract in PartnersPage:
     * pending -> Check connection, consumed -> Back, expired -> New QR.
     */
    static FocusTarget initialFocus(RelayState state) {
        if (state == RelayState.PENDING) return FocusTarget.CHECK_CONNECTION;
        if (state == RelayState.CONSUMED) return FocusTarget.BACK;
        return FocusTarget.NEW_RELAY;
    }

    /**
     * Circular left/right focus used by native modal action rows.
     */
    static int nextHorizontalIndex(int currentIndex, int childCount, int delta) {
        if (childCount <= 0 || (delta != -1 && delta != 1)) return -1;
        int safeCurrent = currentIndex >= 0 && currentIndex < childCount
                ? currentIndex
                : 0;
        return (safeCurrent + delta + childCount) % childCount;
    }

    private static URI safeUri(String value) {
        if (value == null || value.isEmpty()) return null;
        try {
            return new URI(value);
        } catch (Exception ignored) {
            return null;
        }
    }
}
