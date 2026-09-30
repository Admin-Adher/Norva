package tv.norva.playback;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Route-scoped startup budget. Only actual positive media reads count as progress. */
public final class NativeVodStartupProgress {
    public static final long IDLE_TIMEOUT_MS = 35_000L;
    public static final long STARTUP_LIMIT_MS = 120_000L;
    public enum Decision { WAIT, IDLE_TIMEOUT, STARTUP_LIMIT, STOPPED }
    private long generation, startedAt, lastProgressAt;
    private boolean active;
    private boolean routeOpen;
    private final Set<Runnable> readers = new HashSet<>();

    public long begin(long now) {
        List<Runnable> cancelled;
        long route;
        synchronized (this) {
            cancelled = drainReaders();
            route = ++generation;
            startedAt = lastProgressAt = now;
            active = routeOpen = true;
        }
        for (Runnable reader : cancelled) reader.run();
        return route;
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

    /** A rendered frame ends startup tracking, not the playing media route. */
    public synchronized void rendered() { active = false; }

    public synchronized boolean attachReader(long route, Runnable cancel) {
        if (!routeOpen || route != generation) return false;
        readers.add(cancel);
        return true;
    }

    public synchronized void detachReader(Runnable cancel) { readers.remove(cancel); }

    public void stop() {
        List<Runnable> cancelled;
        synchronized (this) {
            active = routeOpen = false;
            generation++; // A cancelled loader cannot keep the next route alive.
            cancelled = drainReaders();
        }
        // Closing I/O is dispatched by each reader, outside the tracker lock.
        for (Runnable reader : cancelled) reader.run();
    }

    private List<Runnable> drainReaders() {
        List<Runnable> cancelled = new ArrayList<>(readers);
        readers.clear();
        return cancelled;
    }
}
