-- Whisper backfill candidate selection, DB-side. PostgREST can't cleanly express
-- "audio_tracks jsonb array contains an element with lang null" (the supabase-js client
-- mis-serializes a jsonb array value as a Postgres array literal), so expose it as an RPC
-- using the raw @> containment. Returns titles that still hold an untagged audio track and
-- were NOT attempted within the retry window, so each whisper tick gets real candidates and
-- the queue advances (instead of the old in-memory filter that scanned the first N titles by
-- id and almost never saw the sparse untagged residual). Idempotent.
create or replace function public.whisper_candidate_titles(
  p_user uuid, p_item_type text, p_limit int,
  p_retry_before timestamptz, p_after uuid default null
) returns table (id uuid, default_variant_id uuid, provider_tmdb_id text, audio_tracks jsonb)
language sql stable security definer set search_path = public as $$
  select t.id, t.default_variant_id, t.provider_tmdb_id, t.audio_tracks
  from cloud_titles t
  where t.user_id = p_user and t.item_type = p_item_type and t.variant_count > 0
    and t.audio_tracks @> '[{"lang":null}]'::jsonb
    and (t.whisper_attempted_at is null or t.whisper_attempted_at < p_retry_before)
    and (p_after is null or t.id > p_after)
  order by t.id
  limit greatest(1, least(coalesce(p_limit, 4), 200));
$$;
revoke all on function public.whisper_candidate_titles(uuid,text,int,timestamptz,uuid) from anon, authenticated;
