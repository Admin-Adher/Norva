package tv.norva.tv;

/**
 * Bounded fail-closed policy for cloud playback liveness checks.
 *
 * <p>An explicit server statement that the session is superseded, unauthorized,
 * absent or inactive is terminal immediately. Transport failures are different:
 * Wi-Fi roaming and brief renderer stalls are expected on televisions, so they
 * stop playback only after at least four consecutive failures spanning 45
 * seconds. Requiring both budgets prevents a single incident, or a burst of fast
 * 5xx responses, from interrupting otherwise healthy playback.</p>
 */
final class PlaybackHeartbeatFailurePolicy {
    static final int MIN_TRANSIENT_FAILURE_COUNT = 4;
    static final long MIN_TRANSIENT_FAILURE_WINDOW_MS = 45_000L;

    enum Decision {
        CONTINUE,
        STOP_SUPERSEDED,
        STOP_SESSION_INVALID,
        STOP_NETWORK_UNVERIFIED
    }

    private int consecutiveTransientFailures;
    private long firstTransientFailureElapsedMs;

    Decision onResult(String resultCode, long nowElapsedMs) {
        if ("ok".equals(resultCode)) {
            reset();
            return Decision.CONTINUE;
        }
        if (ProviderPlaybackPolicy.PLAYBACK_SUPERSEDED.equals(resultCode)) {
            reset();
            return Decision.STOP_SUPERSEDED;
        }
        if (isExplicitSessionInvalid(resultCode)) {
            reset();
            return Decision.STOP_SESSION_INVALID;
        }

        if (consecutiveTransientFailures == 0) {
            firstTransientFailureElapsedMs = Math.max(0L, nowElapsedMs);
        }
        consecutiveTransientFailures++;
        long elapsed = Math.max(0L, nowElapsedMs - firstTransientFailureElapsedMs);
        if (consecutiveTransientFailures >= MIN_TRANSIENT_FAILURE_COUNT
                && elapsed >= MIN_TRANSIENT_FAILURE_WINDOW_MS) {
            return Decision.STOP_NETWORK_UNVERIFIED;
        }
        return Decision.CONTINUE;
    }

    void reset() {
        consecutiveTransientFailures = 0;
        firstTransientFailureElapsedMs = 0L;
    }

    private static boolean isExplicitSessionInvalid(String resultCode) {
        return "HTTP_400".equals(resultCode)
                || "HTTP_401".equals(resultCode)
                || "HTTP_403".equals(resultCode)
                || "HTTP_404".equals(resultCode)
                || "HTTP_409".equals(resultCode)
                || "HTTP_410".equals(resultCode)
                || "HTTP_422".equals(resultCode);
    }
}
