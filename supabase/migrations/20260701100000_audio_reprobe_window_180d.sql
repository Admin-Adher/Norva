-- Enrichment throughput — stop wasting provider connections re-probing deterministic-`und` titles.
--
-- A title's audio candidacy is `audio_languages = '{}' AND (audio_probed_at IS NULL OR
-- audio_probed_at < now() - <window>)`. The window was 30 days, meant to let TRANSIENT provider
-- failures recover. But transient failures (relay 429 / 5xx) never set `audio_probed_at` at all —
-- runOneDimension returns early on relayNotOk WITHOUT the marker, so they retry on the very next
-- tick. The ONLY titles that carry `audio_probed_at` yet stay unresolved are DETERMINISTIC
-- negatives: the relay succeeded but the container exposes no usable audio language (super8k/AÎRO
-- probe-`und`; ~27k titles across the drivers today). Re-probing those is near-guaranteed waste —
-- the container will not grow a language tag between passes — and every wasted probe is a provider
-- connection that a never-probed title could have used.
--
-- During the FIRST pass this predicate is a no-op (all pending titles have audio_probed_at IS NULL,
-- included by both windows identically), so widening it changes nothing today. It only bites once a
-- panel finishes its first pass: at 30d, super8k would re-probe its ~9.7k `und` titles ~12×/year;
-- at 180d, ~2×/year — 6× fewer pointless provider hits (and 6× less load on the panel), while still
-- eventually re-checking in case a provider ever re-encodes a file with proper language tags.
--
-- The account-wide path (runOneDimension, no sourceId) carries the twin 30d constant in
-- norva-playback/index.ts (probeRetryBefore) — bumped to 180d there in the same change to stay in
-- sync. Only the audio-branch window changes here; the subtitle branch (subtitle_probed_at IS NULL)
-- is untouched.
create or replace function public.audio_backfill_candidates(
  p_user uuid,
  p_source uuid,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
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
           'or ct.audio_probed_at < now() - interval ''180 days'')'
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
  'accounts can enrich each host in parallel. Audio re-probe window is 180d: deterministic-und '
  'containers stop churning the single connection slot once a panel finishes its first pass.';
