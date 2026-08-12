package tv.norva.phone;

import java.util.Locale;
import java.util.regex.Pattern;

/** Pure, bounded policy for durable native playback-session close delivery. */
final class NativePlaybackClosePolicy {
    static final int MAX_ACKNOWLEDGED_CLOSES = 64;
    static final int MAX_PENDING_CLOSES = 64;
    static final int MAX_DELIVERY_ATTEMPTS = 5;
    static final long MAX_PENDING_AGE_MS = 12L * 60L * 60L * 1_000L;
    private static final Pattern UUID = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE);
    private static final long[] NOT_READY_DELAYS_MS = {
            500L, 1_500L, 4_000L, 8_000L
    };
    // standalone.js owns a 12-second request timeout. Do not burn a retry
    // while its accepted exact-expiry task can still complete and ACK.
    private static final long[] ACCEPTED_ACK_DELAYS_MS = {
            13_000L, 30_000L, 60_000L, 120_000L
    };

    private NativePlaybackClosePolicy() { }

    static String boundedSessionId(String value) {
        if (value == null || value.length() != 36 || !UUID.matcher(value).matches()) return null;
        return value.toLowerCase(Locale.ROOT);
    }

    static String boundedReason(String value) {
        if ("ended".equals(value)
                || "variant_change".equals(value)
                || "recovery_abandoned".equals(value)
                || "terminal".equals(value)
                || "offline".equals(value)
                || "closed".equals(value)) return value;
        return "closed";
    }

    static String encode(String sessionId, String reason, long createdAtEpochMs) {
        String boundedSessionId = boundedSessionId(sessionId);
        if (boundedSessionId == null || createdAtEpochMs <= 0L) return null;
        return boundedSessionId + "|" + boundedReason(reason) + "|" + createdAtEpochMs;
    }

    static Entry decode(String encoded, long nowEpochMs) {
        if (encoded == null || encoded.length() > 96 || nowEpochMs <= 0L) return null;
        int reasonSeparator = encoded.indexOf('|');
        int timeSeparator = encoded.indexOf('|', reasonSeparator + 1);
        if (reasonSeparator != 36 || timeSeparator <= reasonSeparator + 1
                || encoded.indexOf('|', timeSeparator + 1) >= 0) return null;
        String sessionId = boundedSessionId(encoded.substring(0, reasonSeparator));
        if (sessionId == null) return null;
        String rawReason = encoded.substring(reasonSeparator + 1, timeSeparator);
        String reason = boundedReason(rawReason);
        if (!reason.equals(rawReason)) return null;
        final long createdAtEpochMs;
        try {
            createdAtEpochMs = Long.parseLong(encoded.substring(timeSeparator + 1));
        } catch (NumberFormatException ignored) {
            return null;
        }
        long ageMs = nowEpochMs - createdAtEpochMs;
        if (createdAtEpochMs <= 0L || ageMs < 0L || ageMs >= MAX_PENDING_AGE_MS) return null;
        return new Entry(sessionId, reason, createdAtEpochMs);
    }

    /**
     * @param attempts number of already-dispatched deliveries, including the
     *                 latest one whose status is being handled
     */
    static long retryDelayMs(int attempts, String status) {
        if (attempts <= 0 || attempts >= MAX_DELIVERY_ATTEMPTS) return -1L;
        long[] delays = "accepted".equals(status)
                ? ACCEPTED_ACK_DELAYS_MS : NOT_READY_DELAYS_MS;
        int index = attempts - 1;
        return index < delays.length ? delays[index] : -1L;
    }

    static final class Entry {
        final String sessionId;
        final String reason;
        final long createdAtEpochMs;

        Entry(String sessionId, String reason, long createdAtEpochMs) {
            this.sessionId = sessionId;
            this.reason = reason;
            this.createdAtEpochMs = createdAtEpochMs;
        }
    }
}
