package tv.norva.playback;

/** Route-scoped startup budget. Only actual positive media reads count as progress. */
public final class NativeVodStartupProgress {
    public static final long IDLE_TIMEOUT_MS = 35_000L;
    public static final long STARTUP_LIMIT_MS = 120_000L;
    public enum Decision { WAIT, IDLE_TIMEOUT, STARTUP_LIMIT, STOPPED }
    private long generation, startedAt, lastProgressAt;
    private boolean active;

    public synchronized long begin(long now) {
        generation++;
        startedAt = lastProgressAt = now;
        active = true;
        return generation;
    }

    public synchronized void bytesRead(long route, int count, long now) {
        if (active && route == generation && count > 0 && now >= lastProgressAt) {
            lastProgressAt = now;
        }
    }

    public synchronized boolean active() { return active; }

    public synchronized Decision decision(long now) {
        if (!active) return Decision.STOPPED;
        if (now - startedAt >= STARTUP_LIMIT_MS) return Decision.STARTUP_LIMIT;
        if (now - lastProgressAt >= IDLE_TIMEOUT_MS) return Decision.IDLE_TIMEOUT;
        return Decision.WAIT;
    }

    public synchronized long nextCheckMs(long now) {
        return Math.max(1L, Math.min(STARTUP_LIMIT_MS - (now - startedAt),
                IDLE_TIMEOUT_MS - (now - lastProgressAt)));
    }

    public synchronized boolean mayRenewLease(long now) {
        return decision(now) == Decision.WAIT;
    }

    public synchronized void stop() {
        active = false;
        generation++; // A cancelled loader cannot keep the next route alive.
    }
}
