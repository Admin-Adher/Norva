# Audio campaign reliability — 5 October 2026

## Scope and diagnosis

The hourly Codex heartbeat was deleted at Adrien's request. This change repairs the independent server campaign; it does not recreate that schedule.

Repeated metadata admissions returned SQL 57014, including 05:15 and 05:54 UTC. The historical failure-report RPC HTTP 500 remains a distinct event; its precise SQL cause has not been established. A 60-sample natural observation at 06:00–06:01 UTC found nine active metadata calls, no observed wait or blocker, and a maximum observed age of 0.940 s. This does not identify the waits of earlier failed calls.

Two reproducible defects were isolated:

1. Featured selection ran the complex declaration predicate before cheap exclusions and even for already-observed audio. The original Boolean OR did not impose short-circuit evaluation order. The same exact truth is now evaluated as observation, hint, then declaration using CASE; ownership, source, visible generation, exact file, and canonical language predicates are preserved. A materialized eligibility stage removes declarations already visited and future retries before invoking the truth predicate.
2. Metadata admission waited for the global admission advisory lock while holding its source lock. Under an independently held global lock, the old function reached a 1,500 ms statement timeout in the isolated proof. The new try-lock returns the existing metadata-capacity deferral with hasMore=true, no sweep/retry writes and no provider attempt. The global mutual exclusion and all subsequent capacity/provider guards remain required.

The lock reproduction establishes behavior under contention, not retrospective attribution of every historical 57014.

## Evidence

- Production read selection only, no provider I/O: all 11 currently eligible Xtream source selections are equivalent in individual REPEATABLE READ snapshots. Temporary comparison functions are session-local and rolled back; no application data was modified.
- Most expensive sampled source: original selection 2,086.693 ms; cheap-exclusion-only prototype 910.555 ms; complete candidate with a function boundary 97.719 ms. These are query measurements, not an end-to-end throughput multiplier.
- Networkless schema-only PostgreSQL clone, zero customer rows: 31 existing metadata assertions, 39 featured priority/admission assertions, 15 new truth/short-circuit assertions and 3 contention assertions passed (88 total).
- Independent concurrent lock proof: baseline timeout at 1,563.233 ms; repaired deferral at 81.830 ms, zero cursor writes, zero provider requests.
- Fixture corrections retained: schema export initially omitted ACLs; its role filter omitted pgbouncer, so ACL tests failed until actual ACLs and that role were restored in the isolated clone. One synthetic unobserved-audio row violated the existing state check; the fixture was corrected to an empty language array. No production guard was weakened.

Receipts: `.codex-artifacts/language-reliability-20261005/`.

## Preserved behavior and limits

No model, confidence threshold, four-window consensus, provider connection limit, retry deadline, quarantine, lease duration, dispatcher count, or cron cadence changes. No replay of consumed operators or admission of the three terminal featured jobs. The five human confirmations retain their distinct provenance; Bolt remains strictly verified. Lost, Ochi and Mars remain without sufficient evidence and their 6 October deadlines remain intact.

This repair does not certify every unknown language or claim that provider extraction failures and the distinct historical failure-report SQL errors have all disappeared.

## Delivered and observed

PR 659 was integrated as `2ffa976e6e864bf28611c0f012fa395d6902703c`, code `e6b77152c6d6327f4cc501b4d1ba656bad0fe29c`, after all twelve checks passed, including Android and Windows packages.

Migration `20261005080000_audio_selection_short_circuit` applied **06:19:47.379 UTC / 08:19 Paris**. SHA-256 `2a19e2c2128a7ccb64169d59f89c4a4996faaeeedd86f515011e8f2419d1d4b0`. Readback at 06:20:15 UTC matches the isolated proof:

- `catalog_movie_audio_identified`: MD5 `90a62de1d22d7058454424a503697c4f`.
- `claim_catalog_provider_audio_metadata`: MD5 `e5b8946039a0f5467fe25ac3d02b27f6`.
- All 1,304 other public functions/procedures, and the changed functions' owners, ACLs and attributes are unchanged. Strict jobs, human evidence, metadata cursors/retries and account affinities were compared in the same REPEATABLE READ snapshot and remained unchanged.
- Zero application row writes, media requests, service restarts, admission pauses or forced leases. The two Edge and two Gateways retain their previous start times and are healthy; discovery and the permanent dispatcher remain active for 54 sources / 47 owners.
- The consumed deployment marker is `/home/adrien/.norva/audio-reliability-20261005/apply.consumed`; do not replay it. The isolated proof container was stopped and removed. The first cleanup guard detected its inherited label before any deletion; the actual creation label and network isolation were verified before removal.

### Ordinary processing, not operator replay

Between 06:20:18 and 06:22:28 UTC, pg_stat_statements accumulated **88 successful metadata admission calls**, with a delta mean of **94.865 ms**. Historical aborted calls are not represented by this successful-call metric. No global before/after speed multiplier is inferred from different source mixes.

Dispatcher window 06:19:47–06:22:49 UTC: 17 dispatch events, five batches with attempts, 114 attempt receipts and 61 identification receipts, zero failed receipts or dispatcher HTTP errors. These global receipt counts are not unique files and not strict audio validations. Account-busy, circuit, capacity and resting guards continue to defer work. One source discovery confirms 54 sources / 47 owners.

No new Edge database-timeout/finalization diagnostic or metadata/finalize/fail RPC HTTP 500 occurred in this short window. Unrelated routes still have errors and are not certified by this repair. An additional strict-worker HTTP 403 at 06:22:00.871 coexists with the ordinary 202 at 06:22:00.364; the same paired pattern existed before deployment at 06:16. Calls are pg_net. The single active one-minute worker cron and ordinary 202 responses from 06:15 through 06:24 were verified; origin of the extra denied requests is not established. Do not present all HTTP traffic as error-free or attribute this to the patch.

### Comparable campaign counts

At **08:21 Paris**, the same initial manifest of **56,751 variants / 43,125 titles**, four catalogues of the initial account, remains fully visible:

| Metric | Current | Change since 07:16 Paris |
| --- | ---: | ---: |
| Unique technical checks | 26,078 | +542 |
| Identified, historical metadata/track counter | 8,636 | +81 |
| Unknown variants | 48,115 | -81 |
| Unknown titles | 38,216 | -73 |

The intermediate predeployment readings at 08:15–08:17 were 26,029 checked / 8,620 identified / 48,131 unknown. The subsequent +49 checks and +16 identifications straddle deployment and must not all be attributed to it. At 08:26 Paris, strict audit remains **43 complete validations / 87 complete inconclusive compatible analyses**; these sets overlap and are not added to the historical counter. The five owner-listening confirmations are separate and their stored evidence is unchanged.

The four target-copy audit at 08:21 confirms Bolt still verified and Lost/Ochi/Mars still incomplete with their original 6 October retry/quarantine deadlines and evidence preserved. No new manual job or sampling pass was admitted. Three of the six requested exact copies remain established: Innocent es and Prey en by human listening, Bolt en by strict validation.

The hourly Codex automation file remains absent. The permanent server campaign continues independently. Completion of every unknown audio language and resolution of every past failure-report error are not claimed.
