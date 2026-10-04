# Global audio language maintenance and featured VOD priority — 4 October 2026

## Scope and invariants

The accelerated campaign discovers every visible, ready, enabled source belonging to an undeleted, unbanned account. Revoked/refunded/fraud entitlements remain excluded. Future ready imports enter automatically through a five-minute service-only discovery RPC. The original private four-source cohort and its counters remain the historical measurement baseline; they are not a global unknown-language count.

The catalogue records owner-scoped scheduling hints from the actual hydrated Home and genre rail responses, including first-page source/category rails. First cards across categories precede later cards. Both movies and series are covered. Series priority applies to inventory and exact owned episode probe/LID selection, without assigning one episode's language to a whole series.

Priority changes ordering only: manual requests and completed receipt finalizers still precede new captures; retries, quarantines, profile guards, source generations, provider account/file leases, playback preemption and adaptive resource admission remain authoritative. The campaign retains one in-flight request and the existing strict-worker time window. It does not add one concurrent worker per customer.

Hints expire after 48 hours and repeated catalogue views refresh at most every six hours. Recording them is deferred from the response with a 1.5-second deadline, contains no provider I/O, and failure never prevents catalogue rendering. No language is fabricated or inferred from prominence.

## Verification before deployment

- Live inventory at 08:44 UTC: 53 visible ready catalogues, 47 owners, 44 M3U / 9 Xtream. Existing ordinary global enrichment and strict cron active.
- 95 focused JavaScript tests passed: discovery pagination/fail-closed, future sources, preserved counters and uncertain restart leases, rail IDs, account access, provider connection and viewer precedence.
- 39 assertions passed on a networkless, schema-only PostgreSQL clone using synthetic rows and transaction rollback. Real scheduling functions exercised for films, series, episodes, strict captures and complete receipt finalization. Foreign-owner hints rejected; future retries/quarantine preserved; same provider account rejects a second holder; an active playback session blocks the background lease. Shared Selection virtual titles and exact-file job priority are covered. Only adaptive capacity functions were stubbed inside the rolled-back ordering fixture.
- Six existing Home response/recommendation contract tests passed. Their assertion now accepts the unchanged response payload being assigned before deferred priority recording.
- Existing production definitions are checked byte-for-byte before the six ordering changes. SQL rollout aborts on drift.

## Deployment and runtime evidence

Production deployment is active, on both Edge replicas and the existing server dispatcher. Reference PR: https://github.com/Admin-Adher/Norva/pull/623. Runtime receipts are in `2026-10-04-global-featured-language-runtime.json`; detailed tenant/media inputs remain private on the server.

| Component | Deployment UTC, 4 October | Reference |
|---|---|---|
| Global source discovery and six scheduling order changes | 09:12:51 | Migrations `20261004100000` and `20261004100500` |
| Catalogue Edge replica 1 / 2 | 09:14:57 / 09:15:01 | Code `c2f946e0e`; catalogue SHA-256 `5083a1a021ee991463a47d16771c31b00774fd3255cbdf2fc4af674f5d2b6d48` |
| Global dispatcher | 09:16:03 | SHA-256 `87120a630a7434f0dd93dfeffc91d6dae06c7b7fb2c70311be5ca8933252380b` |
| Bounded visible-card recording, shared Selection support | By 09:26:58 | Migration `20261004103000`, code `53bc4939e` |
| Bounded featured film candidate selection | 09:44:46 | Migration `20261004104000`, code `3e1fe8f89` |
| Direct path for already-due featured series inventories | 09:51:20 | Migration `20261004105000`, code `42839e96e` |

The catalogue helper SHA-256 is `ea05597a5cc2a0ebff55a13f83f192edef483dfbffcc209a86ad253904773d75`. No native application update is required for this server scheduling change. Both Edge replicas retain playback code SHA-256 `bfa8f6213a89a512e3ac33610a9a6ee191f3dc968319ab12fb9b4bff558e5bea`.

The Edge deployment briefly paused new admissions from 09:13:06 to 09:15:03 and waited for leases to drain naturally. Admission and the strict cron were restored. The dispatcher then stopped gracefully with no request in flight before being replaced; its original manifest, counters and outstanding delays were preserved. Later SQL corrections required no restart or forced job mutation.

### Measured global activation

At 09:55:08 UTC, the discovery returned **53 ready sources / 47 owners**. The dispatcher had reached all **49 sources / 46 owners outside the original cohort**. Those sources returned **582 attempted-operation receipts and 241 identification receipts**; these are cumulative receipts, **not an audited count of unique global files**. No second dispatcher or worker per owner was created.

Both Edge health checks are healthy. Both production Gateways returned HTTP 200 / `ok: true`; one has no Docker health check, so its HTTP result is recorded separately. The dispatcher reports successful discovery, one-or-zero in-flight request, no restart, active admission and an active strict cron. Paginated monitoring now covers more than the first 128 sources as the account population grows.

The permanent server discovery includes future eligible accounts/imports within the five-minute discovery interval. The historical four-source manifest remains immutable and is measured separately; the old script's `currentGlobal` field means **the original owner**, not all Norva accounts.

### Actual application-to-priority evidence

- On both Edge replicas, the controlled account's actual film genre response contained **14 rails / 168 cards**; the series response contained **13 rails / 152 cards**. The catalogue layout and response contract were retained.
- Browsing the Series page in Codex, including Dino and MAX OTT, naturally created owner-scoped scheduling hints. The audited table reached **364 distinct physical titles: 168 films and 196 series** at 09:55. These are cumulative hints from different visited views, not 364 simultaneously visible cards. The initial 168-film write was also independently exercised with the exact hydrated response.
- Returning to Films showed the same Action rail headed by *Innocent Voices*, *Last Bullet*, and *Proie*. Unknown badges remain until evidence is sufficient; prominence never fabricates a language.
- At 09:53:33, **four featured film variants had entered intake** (three queued for strict analysis, one deferred), and **three strict jobs had real provider progress after priority recording**. These sets overlap. At 09:55:35 two of those jobs had concluded with strict consensus inconclusive; their future retry times remain intact. This proves real pipeline use, not completion or successful identification of every displayed title.
- The actual series inventory selector chose a featured series first for **Strng, Dino and MAX OTT**, in **0.791 / 0.303 / 0.104 seconds** respectively. Strng's actual episode probe/LID selectors also chose featured episodes first (0.514 / 0.209 seconds). Dino/MAX OTT had no featured episode eligible at that snapshot; their due ordinary work was preserved. No series-wide language was inferred from one episode.

### Corrections prompted by production evidence

1. **Visible title recording:** the initial full canonical-view lookup timed out at eight seconds for 168 cards. Bounding physical IDs and preserving shared-title visibility brought the same operation to **95 ms**, HTTP 200, 168 rows recorded. Deferred recording never blocked the catalogue response.
2. **Featured candidate planning:** three natural HTTP 500 / SQL timeout diagnostics appeared at 09:32:32 (Selection), 09:33:34 (MAX OTT), and 09:34:22 (Strng). Read-only generic-plan comparisons reproduced eight-second timeouts in all seven source/claim combinations. Materializing only the displayed candidates reduced them to **88–1,798 ms**. Custom-plan results were already faster on some Xtream sources; the generic-plan distinction is important. This benchmark measures the SELECT, not the complete network probe. Transactional migration and 37 SQL assertions passed before deployment; original source delays were not shortened.
3. **Series inventory:** the full-account language scan exceeded eight seconds before finding already-due displayed series. A guarded fast path selects those due inventories directly; the original six-hour refresh eligibility and ordinary query remain the fallback when no due featured inventory exists. Future retry tests and all 39 assertions pass. This is not a claim that all ordinary unfeatured inventory scans have been accelerated.

Read models briefly had empty genre candidates and recovered through the existing scheduled refresh at 09:20. The explicit API checks above returned cards afterward; this task does not certify that every catalogue view is instantaneous.

Natural recovery after candidate correction, observed at 09:58:16: Selection resumed a real probe at 09:54:32 (incomplete codec profile, no invented language); Strng resumed 20 metadata checks at 09:56:21 (no usable declared language); MAX OTT returned normally at 09:54:20 but deferred for an occupied provider account, with zero attempted media probes. No additional dispatcher HTTP failure occurred after the three recorded pre-correction failures in this observation window. This does not erase their history or certify every upstream file.

All eleven CI checks on the final scheduling code `42839e96e` completed successfully: disposable database, cloud/Edge contracts, mocked customer journey, notification policy, GoTrue acceptance, phone/TV compile and tests, phone/TV packages and Windows package. The following report/monitor-only commit does not change scheduling or application code.

### Operations and rollback

- Permanent dispatcher: `norva-language-campaign`; state and original manifest remain in `/home/adrien/.norva/all-unknown-language-20261003`.
- Deployment manifests and private rollback references: `/home/adrien/.norva/global-featured-language-20261004`. The stopped former dispatcher is retained as `norva-language-campaign-before-global-20261004`; never run both simultaneously.
- Read-only aggregate monitoring sources: `ops/hetzner/scripts/global-language-runtime-20261004.py`, `featured-language-progress-20261004.py`, and `featured-language-eligibility-20261004.py`. Server copies use the historical short audit names recorded in the heartbeat.
- The hourly follow-up has been updated for all current/future accounts and featured VOD. It must **not stop the permanent dispatcher merely because the original cohort closes**. It preserves the historical finalizer failure and quarantine evidence and stays quiet on unchanged/non-actionable status.
- Do not restore old counters, reset retry timestamps, force leases, or replay inconclusive jobs during rollback. Ordering migrations retain previous definitions under drift guards for a reviewed rollback if needed.

## Interpretation

Global activation and prioritization do not certify completion of the entire language backlog. A provider can refuse or defer a probe; a complete voice analysis can remain inconclusive. Counts of technical checks, identified variants and completed strict voice analyses must remain separate. External playback outside Norva is observable only to the extent the provider reports it; no implementation can guarantee a provider will never ban an account.

## Follow-up, 4 October 10:05–10:12 UTC

The merged reference is `f15130045f4e687fda9c8adcfc696f11ee4d825e` (PR 623). All twelve GitHub check-runs on the final report/monitor commit `a95440cae` now succeeded, including the Windows package. The earlier separate `norva` Vercel preview quota failure is retained; no repeated deployment was requested. Production Edge/SQL/dispatcher deployment remains the one documented above.

At 10:05, all **53 sources / 47 owners** remained discovered, including **49 sources / 46 owners outside the original cohort** already called. Their cumulative receipts reached **678 attempted operations / 297 identifications**. At 10:11:59, they reached **734 / 330**. These are receipts and cannot be advertised as unique identified files. No new source appeared in this interval; future-source inclusion remains covered by implementation and isolated tests rather than a newly observed production import.

The **364 scheduling hints** remained active. Strict provider progress on featured film variants increased from **three at 10:05 to four at 10:11:59**. Six intake records include four strict admissions and two occupied-account deferrals; two metadata records are also occupied-account deferrals. Deferrals are not probes. This follow-up does not demonstrate a new identified language on those featured titles. The real strict selector took 91 ms at 10:11:59.

Both Edge replicas remained healthy and both Gateways returned HTTP 200 / `ok: true`. Discovery, admission and the strict cron were active, counters preserved, one dispatcher request in flight at the last snapshot. The dispatcher still had exactly the three historical HTTP failures described above, with no new failure through 10:11:59 and no discovery failure. Current Edge finalization logs at 10:05 had no new diagnostic; older errors remain part of the history.

The original immutable cohort is reported separately: **17,407 unique technical checks, 6,266 identified variants, 50,485 still unknown**, with **35 complete strict validations and 77 complete inconclusive analyses matching the current profile**. Its observed rate fell to **472 technical checks/hour** over 97 min 52 s spanning deployments and expansion to all accounts. This is not the throughput of the new global service and cannot predict exhaustive voice-analysis completion.

A separate Strng job was observed after an automatic checkpoint reset: 29 provider attempts, zero current receipts, matching current profile, no active lease and not selected by the actual two-job selector at 10:10. Its last update was 09:35:40. Existing receipts can be rejected for expiration, key incompatibility, authentication or consensus validity; the precise reason for this reset was not logged and is **not established**. No retry, lease, receipt, threshold or quarantine was changed. The read-only follow-up is `/home/adrien/.norva/language-checkpoint-followup.py`; its private reference is separate from the old SQL-finalizer reference.

No production mutation was performed during this follow-up. Permanent maintenance remains active. Aggregate receipt: `2026-10-04-language-campaign-heartbeat-1205.json`.

## Follow-up, 4 October 11:05–11:10 UTC

Global discovery still covers 53 sources / 47 owners. Outside the original cohort, cumulative receipts reached **1,120 attempted operations / 424 identifications** at 11:05; they are not unique-file counts. Both Gateways returned HTTP 200 / ok, both Edge replicas are healthy, admission and both background crons remain active. Dispatcher HTTP failures remain at the same three historical events; no new finalization diagnostic appeared. All five checks on the previous evidence-only PR 624 now succeeded, packages included.

The displayed-movie metric rose from **131 to 137 identified variants**, with the same 364 priority hints and 6,785 visible featured variants across movies/series. This is not a count of six distinct cards, nor proof that strict voice recognition caused those identifications. The four featured strict jobs with provider progress are now inconclusive and keep their future retry times.

**Featured series inventory progress is not yet demonstrated.** The last inventory turns on Strng at 11:04 and MAX OTT at 11:00 returned provider-account-busy with zero attempts. Their current activity markers at 11:10 are presence and catalogue metadata respectively; Dino has recent catalogue-refresh activity. Those markers are not proof of active playback at the earlier deferral time. The existing five-minute occupancy guard remains unchanged. Elsewhere, two inventory state rows were updated since the series fast-path deployment, but neither belongs to these featured series. Source schedules and recent global strict states are recorded in the new read-only aggregate audit `/home/adrien/.norva/language-global-followup.py`.

The checkpoint-reset Strng job passed admission again and then deferred for provider occupancy at 10:35. Its provider attempts remain 29, receipts zero and last capture 09:35:40; no new capture or repeated reset is claimed. The precise original reset reason remains unknown. Old SQL-finalizer delay and Dino quarantines are preserved.

Original cohort only: **17,913 unique checks / 6,456 identified / 50,295 unknown**, with **36 strict validations and 78 complete current-profile inconclusive analyses**. Rate since the preceding 10:05 observation: **504 technical checks/hour**. No global total of unknown files or completion forecast is asserted. No production mutation during this control. Receipt: `2026-10-04-language-campaign-heartbeat-1305.json`.
