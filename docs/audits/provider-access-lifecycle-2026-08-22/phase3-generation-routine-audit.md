# Phase 3 physical catalogue routine audit

Generated from the final `pg_proc` catalog on the local foundation + Phase 3 migration database.

| Routine | Access | generation_id | Head filter | Visible projection | Status |
|---|---:|---:|---:|---:|---:|
| `admin_enrichment_engine_health()` | READ | no | no | no | **UNSAFE** |
| `audio_backfill_candidates(uuid,uuid,text,text,text[],boolean,integer)` | READ | no | no | no | **UNSAFE** |
| `catalog_dedup_report()` | READ | no | no | no | **UNSAFE** |
| `catalog_episode_file_coordinate_is_registered(text,text)` | READ | no | no | no | **UNSAFE** |
| `catalog_episode_lid_candidates(uuid,uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `catalog_episode_probe_candidates(uuid,uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `catalog_episode_probe_retry_state(uuid,uuid,uuid,text)` | READ | no | no | no | **UNSAFE** |
| `catalog_item_estimate(uuid,text)` | READ | no | no | no | **UNSAFE** |
| `catalog_media_mirror_diff(uuid)` | READ | no | no | no | **UNSAFE** |
| `catalog_series_episode_coordinates(uuid,uuid,text,text)` | READ | no | no | no | **UNSAFE** |
| `catalog_series_episode_coordinates_by_episode(uuid,uuid,text)` | READ | no | no | no | **UNSAFE** |
| `catalog_series_inventory_candidates(uuid,uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `claim_provider_overview_candidates(uuid,uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `cloud_genre_summary(uuid,text,uuid)` | READ | no | no | no | **UNSAFE** |
| `cloud_title_ratings_expand_audit()` | READ | no | no | no | **UNSAFE** |
| `fanout_detected_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean)` | READ | no | no | no | **UNSAFE** |
| `fanout_episode_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean)` | READ | no | no | no | **UNSAFE** |
| `fanout_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean)` | READ | no | no | no | **UNSAFE** |
| `file_audio_backfill_candidates(uuid,uuid,text,text,text[],boolean,integer)` | READ | no | no | no | **UNSAFE** |
| `file_audio_tag_suspect_variants(uuid,uuid,integer,timestamp with time zone,uuid[])` | READ | no | no | no | **UNSAFE** |
| `file_whisper_candidate_variants(uuid,uuid,integer,timestamp with time zone)` | READ | no | no | no | **UNSAFE** |
| `fill_user_audio_from_catalog(uuid,text,integer)` | READ | no | no | no | **UNSAFE** |
| `finalize_catalog_file_audio_validation_job(uuid,text,text,timestamp with time zone,bigint,integer[])` | READ | no | no | no | **UNSAFE** |
| `guard_catalog_series_episode_membership()` | READ | no | no | no | **UNSAFE** |
| `hydrate_catalog_episode_file_tracks(uuid,uuid,text,text[])` | READ | no | no | no | **UNSAFE** |
| `list_media_items_deduped(uuid,text,uuid,text,text,integer,integer,numeric,bigint,text,integer,integer)` | READ | no | no | no | **UNSAFE** |
| `mark_cloud_title_file_audio_verification(uuid,uuid,text,boolean,timestamp with time zone,jsonb)` | READ | no | no | no | **UNSAFE** |
| `norva_backfill_media_identity(uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `norva_cloud_source_lifecycle_guard()` | READ | no | no | no | **UNSAFE** |
| `norva_hydrate_source_category_names(uuid,text,integer)` | READ | no | no | no | **UNSAFE** |
| `norva_recompute_dedup_primary(uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `norva_reconcile_catalog(uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `norva_repoint_title_ratings_on_merge()` | READ | no | no | no | **UNSAFE** |
| `propagate_media_item_years(uuid,uuid,uuid[])` | READ | no | no | no | **UNSAFE** |
| `recompute_cloud_title_file_languages(uuid,uuid)` | READ | no | no | no | **UNSAFE** |
| `record_catalog_file_audio_verification(text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb)` | READ | no | no | no | **UNSAFE** |
| `record_catalog_file_audio_whisper_outcome(text,text,text,boolean,timestamp with time zone,timestamp with time zone,jsonb)` | READ | no | no | no | **UNSAFE** |
| `refresh_catalog_file_audio_detection_provenance(text,text,text,jsonb)` | READ | no | no | no | **UNSAFE** |
| `refresh_cloud_title_rollup(uuid)` | READ | no | no | no | **UNSAFE** |
| `search_media_items(uuid,text,text,integer,boolean)` | READ | no | no | no | **UNSAFE** |
| `thin_source_media_items(uuid)` | READ | no | no | no | **UNSAFE** |
| `top_viewed_titles(text,integer)` | READ | no | no | no | **UNSAFE** |
| `whisper_candidate_titles(uuid,text,integer,timestamp with time zone,uuid,uuid)` | READ | no | no | no | **UNSAFE** |
| `whitelist_subtitle_candidates(uuid,integer)` | READ | no | no | no | **UNSAFE** |
| `backfill_catalog_from_cloud()` | WRITE | no | no | no | **UNSAFE** |
| `claim_catalog_enrichment_sources(integer,integer)` | WRITE | no | no | no | **UNSAFE** |
| `delete_source_items_batch(uuid,uuid,integer)` | WRITE | no | no | no | **UNSAFE** |
| `heal_cloud_title_variants(uuid,uuid)` | WRITE | no | no | no | **UNSAFE** |
| `hydrate_cloud_title_file_languages(uuid,uuid,text,text,text[])` | WRITE | no | no | no | **UNSAFE** |
| `merge_catalog_episode_file_observation(uuid,uuid,text,text,boolean,boolean)` | WRITE | no | no | no | **UNSAFE** |
| `merge_cloud_title_file_languages(uuid,uuid,uuid,text,jsonb,jsonb,boolean,boolean)` | WRITE | no | no | no | **UNSAFE** |
| `norva_canonicalize_titles_for_user(uuid,integer)` | WRITE | no | no | no | **UNSAFE** |
| `norva_promote_source_replacement(uuid,uuid,text,bigint,bigint)` | WRITE | no | no | no | **UNSAFE** |
| `norva_resolve_provider_identity(uuid,text,text,text)` | WRITE | no | no | no | **UNSAFE** |
| `persist_catalog_episode_audio_lid_outcome(uuid,text,text,text,integer,timestamp with time zone,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamp with time zone)` | WRITE | no | no | no | **UNSAFE** |
| `persist_catalog_movie_audio_lid_outcome(uuid,text,text,text,integer,timestamp with time zone,text,text,integer,text,text,text,double precision,text,integer,integer,integer,jsonb,timestamp with time zone)` | WRITE | no | no | no | **UNSAFE** |
| `prune_stale_source_items(uuid,uuid,bigint,integer)` | WRITE | no | no | no | **UNSAFE** |
| `reap_deleted_sources()` | WRITE | no | no | no | **UNSAFE** |
| `record_catalog_episode_probe_outcome(uuid,uuid,uuid,text,boolean,integer,text,text,timestamp with time zone)` | WRITE | no | no | no | **UNSAFE** |
| `record_catalog_file_container_observation(uuid,uuid,uuid,text,text,text,text,jsonb,uuid,timestamp with time zone)` | WRITE | no | no | no | **UNSAFE** |
| `record_catalog_series_inventory_outcome(uuid,uuid,text,boolean,integer,timestamp with time zone,jsonb)` | WRITE | no | no | no | **UNSAFE** |
| `record_provider_overview_outcome(uuid,uuid,text,text,text,text,text,timestamp with time zone,jsonb)` | WRITE | no | no | no | **UNSAFE** |
| `refresh_admin_dashboard()` | WRITE | no | no | no | **UNSAFE** |
| `register_catalog_series_episodes(uuid,uuid,text,jsonb)` | WRITE | no | no | no | **UNSAFE** |
| `snapshot_admin_metrics()` | WRITE | no | no | no | **UNSAFE** |
| `start_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,integer[],text,timestamp with time zone,bigint,jsonb)` | WRITE | no | no | no | **UNSAFE** |
| `sync_source_to_catalog(uuid)` | WRITE | no | no | no | **UNSAFE** |
| `upsert_cloud_title_rating_cas(uuid,uuid,uuid,uuid,text,text,smallint,uuid,bigint,boolean)` | WRITE | no | no | no | **UNSAFE** |
| `norva_compute_catalog_generation_manifest(uuid)` | READ | yes | no | no | **SAFE** |
| `norva_credential_strong_identity_signals(uuid,uuid)` | READ | yes | no | no | **SAFE** |
| `norva_seal_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer,bigint,bigint)` | READ | yes | no | no | **SAFE** |
| `norva_clear_catalog_generation_live_materialization(uuid,uuid,uuid,bigint,bigint,bigint,bigint)` | WRITE | yes | no | no | **SAFE** |
| `norva_copy_credential_generation_episode_state(uuid,uuid,uuid,uuid,text,integer,bigint,integer)` | WRITE | yes | no | no | **SAFE** |
| `norva_delete_catalog_generation_items_batch(uuid,uuid,uuid,bigint,bigint,bigint,bigint,integer)` | WRITE | yes | no | no | **SAFE** |
| `norva_mark_credential_parent_action_complete(uuid,uuid,uuid,uuid,text,integer,text,text,bigint)` | WRITE | yes | no | no | **SAFE** |
| `norva_prune_stale_catalog_generation_items(uuid,uuid,uuid,bigint,bigint,bigint,bigint,bigint,integer)` | WRITE | yes | no | no | **SAFE** |
| `norva_purge_cancelled_credential_generation_batch(uuid,uuid,integer)` | WRITE | yes | no | no | **SAFE** |
| `norva_reset_credential_catalog_generation(uuid,uuid,uuid,uuid,text,integer)` | WRITE | yes | no | no | **SAFE** |

Current result: **78 routines inspected; 68 UNSAFE; activation remains NO-GO.**

## Late fail-closed fence result

After `20260823173000_catalog_generation_legacy_routine_fences.sql`, the same
query additionally constrained by
`has_function_privilege('service_role', proc.oid, 'EXECUTE')` returns **0**.
Unsafe historical definitions remain catalogued above for traceability, but
their PUBLIC/anon/authenticated/service-role execution grants are revoked.
Current sync callers have fenced overloads for variant heal, year propagation,
and source-category hydration. Enrichment/audio/series-inventory routines still
need generation-aware replacements before their revoked functionality can be
restored; zero executable unsafe routines is therefore a fail-closed security
result, not yet feature-parity completion.

## 2026-08-23 fenced series/language parity wave

`20260823173000_catalog_generation_legacy_routine_fences.sql` now also exposes
service-role-only, fully fenced overloads for:

- `register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb)`
- `record_catalog_series_inventory_outcome(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,boolean,integer,timestamptz,jsonb)`
- `hydrate_catalog_episode_file_tracks(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text[])`
- `hydrate_cloud_title_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,text,text[])`

The series registry and inventory conflicts are keyed by
`(source_id,generation_id,parent_series_id[,episode_id])`; all physical reads
are constrained to the supplied active generation. Title file-language rollups
were also re-emitted to join every contributing variant through
`cloud_source_catalog_heads.active_generation_id`, so retained or building
observations cannot alter active rollups. The four original overloads remain
revoked.

The common physical-row write guard now also rejects UUID parent references
whose `(source_id,generation_id)` differs from the child: title variant to media
item, live variant to logical channel/media item, and series membership or
inventory to parent variant. pgTAP exercises an active-A media UUID injected
into a building-B title variant and proves SQLSTATE `23514`. An ordered online
contract migration owns the complementary composite `NOT VALID`/validated FKs;
the runtime guard remains the pre-contract and late-worker defense.

Credential swaps no longer depend on the public `config_hint.username` for the
mono-account activity ledger. A no-policy/RLS source-affinity table stores only
the lowercase SHA-256 of the gateway canonical key (`URL.host.toLowerCase()`
including port, `/`, then case-preserved trimmed username). Creation parks the
validation job at `infinity` until the service-only bind RPC stores candidate
and previous hashes. The source-config trigger flips the hash atomically on
swap and restores it atomically on compensation. `provider_account_touch_many`
and both busy readers hash their raw gateway key inside SQL; touch-by-source and
touch-by-user read only the opaque affinity. pgTAP proves the affinity table is
not directly service/Data-API readable and that candidate/previous activity is
still detected across swap/rollback without adding username to the hint.

The earlier fresh-database evidence (**46/46**, **13/13**) predates the online
expand/backfill/contract split and must not be used as the final rollout gate.
The current late-fence targeted evidence is pgTAP **29/29** and `pglast` **2/2**;
a new full replay is required after `180000`/`181000` stabilize.

### Product-caller residue (functional activation gate remains NO-GO)

Repository `rg` proves that revoked routines are still invoked by current
product code. These calls do not silently fall back; they fail closed today:

- `norva-playback`: `finalize_catalog_file_audio_validation_job`,
  `catalog_series_episode_coordinates_by_episode`,
  `record_catalog_file_container_observation`,
  `record_catalog_file_audio_whisper_outcome`,
  `catalog_episode_probe_retry_state`, `record_catalog_episode_probe_outcome`,
  `whitelist_subtitle_candidates`, `file_audio_tag_suspect_variants`,
  `file_whisper_candidate_variants`, `whisper_candidate_titles`,
  `audio_backfill_candidates`, `catalog_media_mirror_diff`, and the dynamic
  fanouts `fanout_episode_file_tracks_to_users`,
  `fanout_detected_file_tracks_to_users`, `fanout_file_tracks_to_users`, plus
  `refresh_catalog_file_audio_detection_provenance`.
- `norva-catalog`: `search_media_items`, `list_media_items_deduped`,
  `merge_cloud_title_file_languages`, and `top_viewed_titles`.
- `norva-cloud`: `upsert_cloud_title_rating_cas` and
  `catalog_series_episode_coordinates_by_episode`.
- `norva-source-sync` / shared enrichment: `claim_catalog_enrichment_sources`,
  `record_provider_overview_outcome`, `claim_provider_overview_candidates`,
  and `norva_resolve_provider_identity`.

The fenced calls in `norva-source-sync`, `norva-series-info`,
`_shared/vod-title-projection`, `_shared/xtream-sync`, and `norva-cloud`
resolve the new overloads for the five writer routines completed above. The residue list is exact for literal/dynamic
RPC calls under `supabase/functions` at this audit point; therefore functional
parity, unlike the executable-unsafe security count, is not yet complete.

## 2026-08-23 rolling-compatible caller remediation

The late migration now re-emits the current read/derivation callers with their
exact signatures and result contracts, replacing physical `FROM`/`JOIN`
targets with the four head-filtered visible views plus two private active-head
series projections. This covers search/list/top, audio/Whisper candidate reads,
episode coordinate/retry reads, mirror diff, provider-overview claims, and the
dynamic file-track fanouts. A live `pg_proc` query confirms nineteen
service-executable routines contain no direct physical-table reference; the
remaining `fanout_file_tracks_to_users` also updates an active variant rollup
and is therefore in the guarded legacy-writer set until its fenced overload is
contracted.

Current PL/pgSQL write callers that still use legacy signatures are preserved
for DB-first/code-first compatibility and receive an injected guard that raises
`55000` if either Phase 3 feature flag is enabled. They remain service-only and
functional while both flags are OFF. The explicit online contract, not expand,
owns their final revocation after caller-version evidence. The same rolling
rule applies to Live clearing: the historical seven-argument RPC coexists with
the bounded eight-argument batch RPC until contract.

The automated pgTAP caller inventory checks 27 literal/dynamic product RPC
names and currently reports **0 missing service-executable signatures**. This
removes the earlier immediate product-break residue during the flags-OFF
rolling window, but it is deliberately not a final “zero unsafe” claim: final
activation still requires the non-automatic online contract to prove all
writers use ABA-fenced overloads and revoke the guarded legacy signatures.
After exact reclassification, five of the original eight routines only read a
generation table and write separate logical/cache ledgers; they now retain
their exact signatures over visible/head projections with no activation guard.
Exactly three physical writers remain guarded for rolling compatibility:
global file-track fanout, provider-overview propagation, and container
observation self-heal. Their contracted replacements respectively use an
internally resolved per-owner proof or the full generation/head/config/source-
and-user-visibility suffix. The contract inventory also retires the historical
unbounded Live-clear signature, for four total revocations. The focused
writer/container/overview/audio/catalog suites pass **80/80**, including
DB-first/code-first fallback, missing item-CAS rejection, and an A-to-B switch
between playback resolution and container mismatch persistence.
