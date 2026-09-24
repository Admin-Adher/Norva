# Xtream import runtime reference — 24 September 2026

## Scope

Both production Edge replicas mount the same source tree. The live `_shared/xtream-sync.ts` SHA-256 was `8f4ef919f7e490af5c890e5aa2d4fbab28b1974a6623996b9fd7e41103f856d1` on both routes. The tracked file lacked protections already serving customers. This change imports that exact production file into Git; it does not modify the live Xtream synchronizer.

The recovered behavior joins only a newer account visibility epoch after proving that source ownership, configuration, generation and import head are still current. Idempotent writes retry only after that epoch advances, with a five-attempt cap. The discovery driver checks provider-account viewer occupancy immediately before each upstream call and yields its checkpoint to playback when busy. Heavy-import admission counts visible Xtream and M3U sources and excludes disabled/deleted sources.

## Verification

- A read-only SHA-256 of the mounted production file matched the prior Edge snapshot before copying. The tracked file then matched the same SHA-256 byte for byte.
- 69 generation/import, activity and spool tests passed after reconciliation.
- Four executable tests exercise epoch-change retry, unchanged-epoch refusal, bounded repeated contention and viewer preemption before provider I/O.
- The separate tracked Xtream language declaration parser preserves uppercase track-language tags. A focused parser test confirms those tags keep their audio/subtitle roles. Existing catalogue rows are not retroactively rewritten.

Remaining source-reference differences include the catalogue Edge function and other modules in the production snapshot. This single-file parity is not full Edge rebuild parity. MAX OTT/Dino final raw and variant counts are recorded separately; ordinary paid-account playback and language-facet replay remain open.

## Subsequent Edge input and language rollout

The versioned source-attempt module imports a separate source-input policy that was absent from the live mount. Thirty-two representative URL and domain inputs produced the same bounded diagnostic classification in the live inlined implementation and the versioned module. The versioned language parser adds three sanitized uppercase track-tag keys for future Xtream ingestion; provider declarations still do not count as observed audio tracks.

At 04:34:34 UTC, both Edge replicas received the versioned source-attempt module, its source-input policy dependency, and the versioned language parser. Their SHA-256 values now match Git: `e7925b45427cc991a19cbdfd8b215839709f5fe6ddae6f00ba82e7134024846f`, `f56bc761102d92cc8c3d94faa3ad97a4a75bf8b325726d7d4b6d98823939d34b`, and `54f5ff594c0482a188768f5f2426389201da6afcdd9925cc74c5390ab115cd45`. Each replica restarted healthy and served `norva-cloud` and `norva-source-sync` health requests successfully. Protected backup: `/home/adrien/.norva/edge-input-language-20260924/backup-20260924T043434Z`.

A read-only production check found no actively syncing Xtream source. Twenty M3U sources retain old `syncing` database values, but all are disabled and their progress timestamps are from 5–6 September. The client health classifier gives a disabled source priority over its old sync status. No source or user data was altered during this rollout.
