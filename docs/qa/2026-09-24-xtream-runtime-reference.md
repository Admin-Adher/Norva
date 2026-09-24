# Xtream import runtime reference — 24 September 2026

## Scope

Both production Edge replicas mount the same source tree. The live `_shared/xtream-sync.ts` SHA-256 was `8f4ef919f7e490af5c890e5aa2d4fbab28b1974a6623996b9fd7e41103f856d1` on both routes. The tracked file lacked protections already serving customers. This change imports that exact production file into Git; it does not modify the live Xtream synchronizer.

The recovered behavior joins only a newer account visibility epoch after proving that source ownership, configuration, generation and import head are still current. Idempotent writes retry only after that epoch advances, with a five-attempt cap. The discovery driver checks provider-account viewer occupancy immediately before each upstream call and yields its checkpoint to playback when busy. Heavy-import admission counts visible Xtream and M3U sources and excludes disabled/deleted sources.

## Verification

- A read-only SHA-256 of the mounted production file matched the prior Edge snapshot before copying. The tracked file then matched the same SHA-256 byte for byte.
- 69 generation/import, activity and spool tests passed after reconciliation.
- Four executable tests exercise epoch-change retry, unchanged-epoch refusal, bounded repeated contention and viewer preemption before provider I/O.
- The separate tracked Xtream language declaration parser already preserves uppercase track-language tags that the deployed parser omits. A focused parser test confirms those tags keep their audio/subtitle roles. This is versioned code only until that parser is separately deployed; existing catalogue rows are not retroactively rewritten.

Remaining source-reference differences include the catalogue Edge function and other modules in the production snapshot. This single-file parity is not full Edge rebuild parity. MAX OTT/Dino final raw and variant counts are recorded separately; ordinary paid-account playback and language-facet replay remain open.
