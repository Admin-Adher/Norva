# Selection activation batching and language recovery

## Full activation observed in production

The ordinary QA account's Selection alone was removed and re-added through its
normal button, under the user's existing authorization. Its trial and all other
accounts were retained. No manual finalizer kick occurred during the timed run.

- Button click: 2026-10-01 10:13:05.647 UTC.
- Backend start: 10:13:06.682; READY: 10:14:59.406.
- Full activation: **112.724 seconds**, down from 130.010 seconds in the preceding
  corrected run and 497.494 seconds originally (77.3% reduction from baseline).
- Enriched Home observed by 12.493 seconds. This is an observation upper bound,
  not an instrumented first paint or proof of a regression from the preceding
  9.116-second observation.
- Navigation to Movies during preparation was observed in 805 ms. Browsing did
  not require waiting for completion.
- Final inventory: 8,611 raw entries: 7,724 movies, 276 series, 590 episodes and
  21 live entries; 8,000 bound movie/series variants.
- Foreign owner/source linkage mismatches among those 8,000 variants: **zero**.

This is **not quasi-instantaneous full activation**. Per-owner bindings, file
observations, visibility indexes and rollups still require database writes.
The prepared public recipes remove repeated metadata computation, but do not
yet provide a shared catalogue read model that eliminates those owner writes.
Increasing concurrency or removing database pauses is not an equivalent fix.

## Released batching and route changes

PR 541, merged as `9e0cc331eddef8e817e8f8860bfeb69dba2372a4`:

- Exact-file hydration uses up to 250 records, bounded additionally by 240,000
  UTF-8 bytes for snapshot manifests (SQL limit remains 256 KiB).
- A sole prepared Selection finalizer adapts its pause only for healthy batches;
  cold imports, multiple finalizers and slow batches retain the normal pause.
- Both Edge replicas were hash-verified; the SQL 250-file cap is active globally.
- Both Gateways use image
  `sha256:fbcf2aae019ee6aa338d710fab5601adb73c91889d6ce3bc98b4a989376c0d3f`.
- Public Sandro HTTPS MP4 files under the exact allowlisted `/content/filmes/`
  path use the direct route for ffprobe and strict language capture. URLs with
  credentials, query strings, fragments, alternate paths/hosts or ports do not
  gain this route. Explicit operator overrides remain authoritative.
- Main deployment waited for the active strict audio broker to drain. Existing
  live viewers were not interrupted; the normal audio worker was restarted.

Before this route change, one exact-file probe timed out at 12 seconds through
the relay while a direct probe succeeded in 1.716 seconds. The deployed normal
Gateway endpoint subsequently returned a complete, drained profile in 3.385
seconds. Its `und` track was left unidentified until actual speech verification.

## Missing languages

514 old jobs had exhausted eight attempts with generic Gateway rejection and
had not been retried since 10 September. Three exact-file canaries were replayed:
two Sandro files yielded Portuguese and one HERBERT file yielded Spanish. All
three completed with identified ordered audio tracks before bulk recovery.

The guarded recovery script then requeued the remaining **511** exact jobs.
It retained a private before-state backup and did not replay completed ambiguous
analyses or confirmed truncated files. Normal admission, viewer priority,
attempt limits, file binding and owner checks remain enabled. Requeued does not
mean already identified: the background work can wait for playback and capacity.

The UI subsequently showed 12 identified audio languages and **556 unidentified
entries**, down from 559 at the preceding UI check. Facet counts can change as
verified results are published; distinct titles and physical variants differ.
No language is inferred solely from a translated title or TMDB original language.

The real queue replay exposed an additional retry-accounting defect: attested
viewer preemption consumed the provider-failure budget. The worker now returns
that admission debit using the existing exact lease CAS, as it already did for
attested capacity refusal. Without Gateway drain evidence, retries remain bounded.
The local-capture recovery branch and actual provider-error accounting are retained.

## Runtime and automated verification

- Movie facets, illustrated movie and series lists and Live TV navigation were
  present after full activation; trial indicator remained at seven days.
- Selecting the series Drama category returned 149 titles. The TV guide showed
  its 20 logical channels in 11 groups. The QA account was left on Home, with
  the test playback closed and the temporary series category filter cleared.
- Downton Abbey: A New Era displayed the newly identified Portuguese badge and
  French synopsis. Video reached readyState 4, 1280 x 720, playing at 13.620 s
  by 22.597 s after Play (consistent with about 9 s startup, not first-frame timing).
- Picture verified after seeking to 4:58. After closing and using Reprendre,
  playback continued past that position with readyState 4 and no media error.
  Playback was closed by navigating to Series.
- The batching/route release passed 332 targeted tests with three pre-existing
  environment-dependent skips. All PR 541 CI checks passed, including actual
  disposable database, Edge type checks, mocked journeys and Android tests.
- Actual service-role rollback fixtures validated 240 fresh owner-bound variants
  in 2.556 seconds and a 250-file hydration request in 651 ms, preserving foreign
  file, stale generation, expiry and ownership rejection. Nothing was committed.
- The viewer retry correction passed 41 worker/Gateway tests, including final
  attempt, lease loss, preserved evidence and rejection of unattested debit refunds.

No claim of Android runtime replay, load-test capacity, elimination of every
unknown audio language or instantaneous full activation follows from this run.

## Worker release and remaining queue

PR 542 merged as `61c708f1310159a76729d20a27a7b72deadc4ec8`.
The normal Selection worker stopped cleanly with exit code 0, was patched and
restarted at **2026-10-01 10:28:13.991 UTC**; neither Gateway was restarted for
this worker correction. Runtime SHA-256:
`6fdec2265c3f8fc875a043a4c752a52dea378390aea5fb6012ca76e00cfcaf25`.
The deployed file was read back and matched; worker running, restart count zero.
Cloud-contract CI and Android APK builds succeeded for this commit; its Windows
artifact build was still running at the check (no Windows application code changed).

At 10:31 UTC, the 511 recovered jobs included 19 queued, one running and 491
waiting to retry, mostly after capacity or viewer-priority deferral. None of
these 511 had yet published a completed language result; the three canary
results are separate. Maximum attempt count was two. This queue snapshot does
not certify that all 511 files remain reachable or will yield identifiable speech.
The regular worker continues independently in production, respecting its
existing file/host/network/CPU limits and actual viewer priority.
