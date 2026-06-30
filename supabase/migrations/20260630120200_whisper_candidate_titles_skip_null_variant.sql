-- Phase 2 fix (audit): exclude titles with a null default_variant_id from whisper candidacy. The edge
-- backfill skips such titles (no resolvable variant) and — before the companion edge fix — left them
-- unmarked, so with the cursor-less `limit:4` cron they clogged the front of the candidate queue
-- forever and starved everything behind them. Filtering them out here (plus the edge now marking
-- STRUCTURAL skips as attempted) keeps the queue advancing. Only added condition vs the prior version:
-- `and t.default_variant_id is not null`.
create or replace function public.whisper_candidate_titles(p_user uuid, p_item_type text, p_limit integer, p_retry_before timestamp with time zone, p_after uuid default null::uuid)
returns table(id uuid, default_variant_id uuid, provider_tmdb_id text, audio_tracks jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  select t.id, t.default_variant_id, t.provider_tmdb_id, t.audio_tracks
  from cloud_titles t
  where t.user_id = p_user and t.item_type = p_item_type and t.variant_count > 0
    and t.default_variant_id is not null
    and t.audio_tracks @> '[{"lang":null}]'::jsonb
    and (t.whisper_attempted_at is null or t.whisper_attempted_at < p_retry_before)
    and (p_after is null or t.id > p_after)
  order by t.id
  limit greatest(1, least(coalesce(p_limit, 4), 200));
$function$;
