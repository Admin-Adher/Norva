# Selection shared activation

## Change

Store the qualified public catalogue once, then enroll an authorized source by
one fenced reference. Media, logical title, variant and Live read models bind
that public snapshot to the requesting owner. Activation no longer creates
8,611 media rows, 8,000 variants and their observations for each account.

Playback and reactions create only the selected physical FK targets (one film,
or an episode and its parent). Stable owner-specific IDs preserve isolation.
Other providers retain their existing read paths; mixed accounts use bounded
physical/shared page merging and indexed title runtime lookups.

This does not change entitlement, payment, provider credentials or client UI.
The cloud adapters and scheduled sync adapter all recognize shared enrollment.

## Predeployment evidence

67 focused JavaScript tests passed. All four affected Edge entrypoints bundle.
Real PostgreSQL schema-clone testing used `norva_selection_shared_qa_20261001`,
public catalogue data only and synthetic users inside a rollback transaction.
Tests execute as the actual service role after fixture setup.

- Common release prepared once in 11.9 s, outside enrollment.
- Enrollment: 18.4 ms SQL time, zero owner media/title/variant inventory copies.
- 8,611 visible rows: 7,724 films, 276 series, 590 episodes, 21 Live entries.
- 6,432 logical titles, 12 known audio languages; unknown languages remain honest.
- Home selection, hydration and second cursor page: 429 ms combined.
- Grid, search, genre counts: 469 ms combined; language counts: 220 ms.
- Genre rails, language filtering and Live visibility: 532 ms combined.
- Selected film binding and idempotent repeat: 109 ms combined.
- Two owners get different title/variant IDs; playing on one creates no data on
  the other. Disabling one source hides its catalog without hiding the other.
- Mixed ordinary/shared provider title has one card and both variants.
- Foreign owners and stale epochs cannot write bindings; episode creates only
  its exact row and parent. Full catalogue counts survive lazy binding.

SQL times are not browser first-paint or end-to-end activation measurements.

## Release and rollback

`ops/hetzner/scripts/deploy-selection-shared-20261001.py` checks installed hashes,
applies the nine migrations with enrollment disabled, installs seven Edge files,
publishes a freshly fetched public manifest with exact recipe/file evidence and
complete Live variants, then enables new enrollment globally.

Roll back admission with `disable`. Keep shared read/bind schema and code for
already enrolled accounts; do not delete those references or restore old reads.
Existing physically imported accounts retain their usual import semantics.

Shared memberships pin a qualified release. Publishing another snapshot does
not silently retarget already-bound physical files. Upgrading those memberships
requires a separately qualified bound-file migration. This initial release is
not an automatic rolling metadata-refresh implementation.

## Production evidence

First production button click: 11:40:49.159 UTC. Source created at 11:40:50.209;
shared source ready at 11:40:50.254: about 1.1 s from click, zero physical media.
The first Home render exposed a re-enrollment regression: retained logical title
IDs forced shared variants through the old per-title owner scan. New enrollments
were disabled while the QA membership stayed available for diagnosis.

The follow-up bounds owner lookup and uses the prepared title metadata whenever
there is no currently visible physical variant. Old logical IDs are retained.
Hydration avoids running the physical runtime for these cards. A new fixture
retains an entire previous 6,432-title inventory, then checks both new owners,
mixed providers, exact file binding, languages and visibility. It passes: Home
selection/hydration/cursor 133 ms; grid/search/genres 473 ms; lazy film 70 ms.
Production replays after this correction are recorded below.

The series replay additionally caught an anti-join plan which repeatedly scanned
historical physical variants. The corrected indexed predicate is inside each
physical view branch, before sorting and runtime hydration. Production series
Home selection returned 18 rows in 192 ms; movie selection plus hydration of 96
rows took 675 ms, genre counts 270 ms. The rollback fixture now explicitly checks
series selection and hydration too (37 ms with 6,432 retained identities).

Virtual variants now read their exact shared file tags through a bounded,
service-only, owner-scoped RPC, rather than waiting for private observation rows.
Source, variant, owner, external file ID and URL digest are checked. Series use
language sets, never a synthetic episode track map. Tests reject foreign and
changed-file evidence and keep unknown languages unknown. This follow-up was
installed and hash-verified on both Edge replicas.

Fresh production activation at 12:17:21.641 UTC created source generation 8 at
12:17:23.020, ready at 12:17:23.066: 1.425 s click-to-full-server-readiness, all
8,611 entries visible and zero physical media rows. Home was still preparing at
7.36 s and fully rendered at the next observation (15.18 s). This upper bound is
not a first-paint measurement and is not described as instant UI.

The final SQL optimization skips historical physical-title scanning when this
media type has no visible physical file. Mixed-provider cursors remain intact.
Rollback replay passed again: two Home movie pages plus hydration 61 ms, series
Home 21 ms; both-owner and mixed-provider checks passed.

Real playback before the reset: Creed II decoded 1280×536 video, readyState 4,
advancing at 8.3 s on the observation 18.4 s after click. Reopening with Resume
also decoded video. Only the selected film was materialized; a later episode
created exactly its file and parent. The initial Peaky Blinders and Mathagam
episode requests returned HTTP 409 at Norva's final receipt visibility guard.
It did not yet recognize the exact owned Selection episode as proof after lazy
binding advanced the visibility epoch. An additional provider latency observation
was separate: a direct 1 KiB range from Peaky's existing public CDN took 48 s
before returning HTTP 206 video/mp4. TV displayed 20 logical channels / 21 variants with their
groups. Downton's previously missing Portuguese file label is now displayed in
search, and Creed II exposes its PT/EN exact-file tracks.

Final activation replay after the physical-scan optimization: button click
12:23:01.155 UTC, source generation 9 created 12:23:02.354, ready
12:23:02.411 (**1.256 s click-to-ready**). Exactly **8,611 visible media entries,
zero physical media copies**. The browser still showed preparation at 3.57 s;
the next observation at **9.44 s** showed the complete Home hero, film rails,
series rails and language badges. Thus the observed UI bound is under 10 s,
not an assertion of a subsecond first paint. There is no remaining per-account
full-import task to wait for. Admission is enabled globally.

All seven deployed runtime files were rechecked against both Edge containers.
The follow-up PR checks passed for cloud contracts, Edge type-check, disposable
Supabase migrations, mocked Web/mobile journeys, notification policy, GoTrue
acceptance, and Android Phone/TV compile/tests. No Android player or client UI
layout was changed by this release; native runtime playback was not replayed here.

## Episode receipt correction

The receipt guard now accepts the existing owned Selection episode resolver,
after verifying its currently visible owned parent, exact file, active generation
and source. It cannot fall through to another provider's cache. Fifteen focused
receipt/Selection tests passed, including missing authority, hidden parent and
stale visibility cases. Deployed and hash-verified on both Edge replicas:
`norva-playback/index.ts` SHA-256
`07f20e456bf0fb1d72fcef67bc5a3e76e608f6ee172574439b43e24eebf8429d`.

Mathagam replay returned HTTP 201, decoded 720-pixel-wide video at readyState 4,
and was advancing at 10.37 s in the observation 20.55 s after retry. Escaping
then choosing Continue Watching resumed the same episode: at 27.62 s after
the resume click, video was advancing at 40.01 s. Watch history subsequently
persisted 58 s. Only two physical media rows exist for this source (episode and
series parent); playback did not trigger a full catalogue copy.

A first launch of Peaky Blinders S1E1 on the new source then succeeded without
retry: 1920-pixel-wide video, readyState 4, unpaused, position 28.76 s at the
observation 33.21 s after the click. This also covers first binding of a different
episode after the receipt fix. The earlier 409 is resolved; the separately
observed upstream latency is not treated as a permanent episode failure.
Both test players were closed after validation.

## Home language adapter

The final Home check exposed a second display adapter which discarded language
sets with `series` scope while preserving only `file` scope. Server title cards
now carry the owned episode union; the client Home variant adapter preserves
series sets only for a series. Movies and episodes still cannot inherit these
sets as file proof, and no ordered audio/subtitle tracks are manufactured.
Focused tests cover the actual API adapter and presentation helper. There is
currently no ADB device/emulator attached, so this data-adapter correction has
no new Android WebView runtime certification.
