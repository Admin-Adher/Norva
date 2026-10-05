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

This repair does not certify every unknown language or claim that provider extraction failures and the distinct historical failure-report SQL errors have all disappeared. Production application and ordinary postdeployment progress must be recorded below before claiming delivery.