-- Per-panel (per-source) candidate selection for the audio/subtitle backfill fleet.
--
-- Context: one driving account can carry SEVERAL distinct provider panels (e.g. the AÎRO
-- account `7bdab1df…` holds 5 hosts: Airysat / Ninja / KING365 / Opplex / Promax). The
-- account-wide backfill (`runOneDimension` in norva-playback) drains candidates by user_id
-- only, so all panels share ONE serialized connection slot → a 334k-title account needs
-- ~52 days for a first pass while a single-host account (super8k, 70k) finishes in ~5.
--
-- A cloud_title has no source_id of its own — its panel lives on its DEFAULT variant's
-- source_id (cloud_title_variants). This RPC reproduces the exact account-wide candidate
-- filter (audio unresolved + 30d probe-retry window, OR never-subtitle-probed) but scoped
-- to one source, so each panel can get its own cron/slot and run in parallel WITHOUT
-- increasing any single host's per-connection load (each host still sees one connection —
-- it's just no longer time-shared with its siblings). Distinct hosts → no user_multi_ip.
--
-- VARIANT-DRIVEN (no ORDER BY): walk the source's own variants via the
-- (source_id, item_type, external_id) unique index and join to their titles. Work is BOUNDED
-- by the source's variant count — never the whole multi-tenant cloud_titles table — so an
-- exhausted panel returns fast instead of scanning every user's titles.
-- No ORDER BY: the `audio_probed_at` / `subtitle_probed_at` progression markers already advance
-- the sweep (each probed title drops out), so any N unprobed candidates per tick are fine;
-- dropping the sort lets Postgres early-stop at p_limit for dense panels. The candidate SELECT
-- is trivial next to the tick's real work (N sequential provider probes at concurrency 1).
--
-- plpgsql + dynamic SQL with format(%L) so the selective predicates (source / item_type / user)
-- are LITERALS at plan time. A plain SQL function bound these as parameters → the planner used
-- ONE generic plan for every source and mis-costed the small/exhausted panels (10s+ scans).
-- Interpolating actual values re-plans per call (planning ~5ms, negligible) → a 5k-variant panel
-- gets a bounded nested loop, a 170k one an early-stopping scan. Inputs are trusted internal
-- (backfill-token route only) and %L-quoted, so no injection surface.
create or replace function public.audio_backfill_candidates(
  p_user uuid,
  p_source uuid,
  p_item_type text default 'movie',
  p_target text default 'audio',          -- 'subtitle' = subtitle sweep; else audio sweep
  p_require_tags text[] default null,      -- optional version-tag overlap (&&); null = all
  p_untagged_only boolean default false,   -- restrict to titles with NO version tag
  p_limit int default 25
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text)
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_lim int := greatest(1, least(300, coalesce(p_limit, 25)));
  v_sql text;
begin
  v_sql := format(
    'select ct.id, ct.default_variant_id, ct.provider_tmdb_id '
    'from public.cloud_title_variants v '
    'join public.cloud_titles ct on ct.id = v.title_id and ct.default_variant_id = v.id '
    'where v.source_id = %L and v.item_type = %L and ct.user_id = %L and ct.variant_count > 0 and %s',
    p_source, p_item_type, p_user,
    case when p_target = 'subtitle'
      then 'ct.subtitle_probed_at is null'
      else 'ct.audio_languages = ''{}''::text[] and (ct.audio_probed_at is null '
           'or ct.audio_probed_at < now() - interval ''30 days'')'
    end);
  if p_untagged_only then
    v_sql := v_sql || ' and ct.version_languages = ''{}''::text[]';
  end if;
  if p_require_tags is not null and coalesce(array_length(p_require_tags, 1), 0) > 0 then
    v_sql := v_sql || format(' and ct.version_languages && %L::text[]', p_require_tags);
  end if;
  v_sql := v_sql || format(' limit %s', v_lim);
  return query execute v_sql;
end;
$fn$;

comment on function public.audio_backfill_candidates is
  'Per-source candidate titles for the audio/subtitle backfill (norva-playback/audio-backfill '
  'runOneDimension sourceId path). Scopes a driving account to one provider panel so multi-panel '
  'accounts can enrich each host in parallel without raising per-host connection load.';

-- Whisper (language-detection) candidates, now OPTIONALLY source-scoped. mode:whisper opens a
-- real (short) provider connection per title, so under per-panel parallelism it must stay on the
-- panel's OWN host — otherwise an account-wide whisper could hit host B while host B's own cron is
-- probing → user_multi_ip. p_source null preserves the original account-wide behavior exactly.
-- Adding a trailing param changes the signature, so drop the old 5-arg function first.
drop function if exists public.whisper_candidate_titles(uuid, text, integer, timestamptz, uuid);

create or replace function public.whisper_candidate_titles(
  p_user uuid,
  p_item_type text,
  p_limit integer,
  p_retry_before timestamptz,
  p_after uuid default null,
  p_source uuid default null
) returns table(id uuid, default_variant_id uuid, provider_tmdb_id text, audio_tracks jsonb)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lim int := greatest(1, least(coalesce(p_limit, 4), 200));
  v_sql text;
begin
  if p_source is null then
    -- Account-wide (unchanged): title-driven, id-ordered for the p_after cursor.
    return query
      select t.id, t.default_variant_id, t.provider_tmdb_id, t.audio_tracks
      from public.cloud_titles t
      where t.user_id = p_user and t.item_type = p_item_type and t.variant_count > 0
        and t.default_variant_id is not null
        and t.audio_tracks @> '[{"lang":null}]'::jsonb
        and (t.whisper_attempted_at is null or t.whisper_attempted_at < p_retry_before)
        and (p_after is null or t.id > p_after)
      order by t.id
      limit v_lim;
  else
    -- Source-scoped: variant-driven (bounded by the source), literal-interpolated to avoid the
    -- generic-plan trap. No ORDER BY — whisper_attempted_at drives progression.
    v_sql := format(
      'select t.id, t.default_variant_id, t.provider_tmdb_id, t.audio_tracks '
      'from public.cloud_title_variants v '
      'join public.cloud_titles t on t.id = v.title_id and t.default_variant_id = v.id '
      'where v.source_id = %L and v.item_type = %L and t.user_id = %L and t.variant_count > 0 '
      'and t.audio_tracks @> ''[{"lang":null}]''::jsonb '
      'and (t.whisper_attempted_at is null or t.whisper_attempted_at < %L) '
      'limit %s',
      p_source, p_item_type, p_user, p_retry_before, v_lim);
    return query execute v_sql;
  end if;
end;
$fn$;
