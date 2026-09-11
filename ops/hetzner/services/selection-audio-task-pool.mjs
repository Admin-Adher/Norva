// Work leases are not provider connections. This pool lets a second owned file
// make progress while the first computes locally; Gateway admission owns I/O.
// Keep every promise attached and drain on shutdown, with at most two jobs even
// when repeated polls or stale database capacity observations overlap.
export function createSelectionAudioTaskPool({ maximum = 1, onError = () => {} } = {}) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 2) throw new Error('SELECTION_AUDIO_CONCURRENCY_INVALID');
  const active = new Map(); let filling = false;
  return Object.freeze({
    size: () => active.size,
    async fill({ limit = 1, claim, process, signal }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw new Error('SELECTION_AUDIO_CONCURRENCY_INVALID');
      if (filling || signal?.aborted) return 0;
      filling = true; let started = 0;
      try {
        while (active.size < limit && started < limit && !signal?.aborted) {
          const job = await claim(); if (!job?.external_id) break;
          if (!job.id || active.has(job.id)) throw new Error('SELECTION_AUDIO_DUPLICATE_CLAIM');
          // A claim that finishes during shutdown is still passed the aborted
          // signal so the normal owned job path can release/defer its work.
          const task = Promise.resolve().then(() => process(job)).catch(() => {
            try { onError(); } catch { /* error reporting cannot detach the task */ }
          }).finally(() => { active.delete(job.id); });
          active.set(job.id,task); started++;
        }
        return started;
      } finally { filling = false; }
    },
    async progress() { if (active.size) await Promise.race(active.values()); },
    async drain() { while (active.size) await Promise.all(active.values()); },
  });
}
