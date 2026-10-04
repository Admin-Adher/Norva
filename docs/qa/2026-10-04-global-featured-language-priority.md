# Global audio language maintenance and featured VOD priority — 4 October 2026

## Scope and invariants

The accelerated campaign discovers every visible, ready, enabled source belonging to an undeleted, unbanned account. Revoked/refunded/fraud entitlements remain excluded. Future ready imports enter automatically through a five-minute service-only discovery RPC. The original private four-source cohort and its counters remain the historical measurement baseline; they are not a global unknown-language count.

The catalogue records owner-scoped scheduling hints from the actual hydrated Home and genre rail responses, including first-page source/category rails. First cards across categories precede later cards. Both movies and series are covered. Series priority applies to inventory and exact owned episode probe/LID selection, without assigning one episode's language to a whole series.

Priority changes ordering only: manual requests and completed receipt finalizers still precede new captures; retries, quarantines, profile guards, source generations, provider account/file leases, playback preemption and adaptive resource admission remain authoritative. The campaign retains one in-flight request and the existing strict-worker time window. It does not add one concurrent worker per customer.

Hints expire after 48 hours and repeated catalogue views refresh at most every six hours. Recording them is deferred from the response with a 1.5-second deadline, contains no provider I/O, and failure never prevents catalogue rendering. No language is fabricated or inferred from prominence.

## Verification before deployment

- Live inventory at 08:44 UTC: 53 visible ready catalogues, 47 owners, 44 M3U / 9 Xtream. Existing ordinary global enrichment and strict cron active.
- 95 focused JavaScript tests passed: discovery pagination/fail-closed, future sources, preserved counters and uncertain restart leases, rail IDs, account access, provider connection and viewer precedence.
- 33 assertions passed on a networkless, schema-only PostgreSQL clone using synthetic rows and transaction rollback. Real scheduling functions exercised for films, series, episodes, strict captures and complete receipt finalization. Foreign-owner hints rejected; future retries/quarantine preserved; same provider account rejects a second holder; an active playback session blocks the background lease. Only adaptive capacity functions were stubbed inside the rolled-back ordering fixture.
- Existing production definitions are checked byte-for-byte before the six ordering changes. SQL rollout aborts on drift.

## Deployment and runtime evidence

Pending at the initial code commit. This section will be updated with exact receipts, runtime observations and limits before claiming activation.

## Interpretation

Global activation and prioritization do not certify completion of the entire language backlog. A provider can refuse or defer a probe; a complete voice analysis can remain inconclusive. Counts of technical checks, identified variants and completed strict voice analyses must remain separate. External playback outside Norva is observable only to the extent the provider reports it; no implementation can guarantee a provider will never ban an account.
