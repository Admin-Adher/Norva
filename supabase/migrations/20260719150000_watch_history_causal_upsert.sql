-- Atomic cross-device watch progress.
--
-- The edge used to SELECT the current row and then UPSERT it. Two devices could
-- both read the same old value, after which the older captured position could
-- arrive last and win. Compare watched_at in the conflict update itself so the
-- decision is serialized by PostgreSQL's unique-index lock.

begin;

create or replace function public.upsert_cloud_watch_history_causal(
  p_user_id uuid,
  p_profile_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_item_id text,
  p_parent_item_id text,
  p_item_name text,
  p_progress_seconds integer,
  p_duration_seconds integer,
  p_completed boolean,
  p_data jsonb,
  p_watched_at timestamptz
)
returns setof public.cloud_watch_history
language plpgsql
security definer
set search_path = public
as $$
declare
  saved public.cloud_watch_history%rowtype;
begin
  insert into public.cloud_watch_history (
    user_id,
    profile_id,
    source_id,
    item_type,
    item_id,
    parent_item_id,
    item_name,
    progress_seconds,
    duration_seconds,
    completed,
    data,
    watched_at
  )
  values (
    p_user_id,
    p_profile_id,
    p_source_id,
    p_item_type,
    p_item_id,
    p_parent_item_id,
    p_item_name,
    greatest(coalesce(p_progress_seconds, 0), 0),
    greatest(coalesce(p_duration_seconds, 0), 0),
    coalesce(p_completed, false),
    coalesce(p_data, '{}'::jsonb),
    coalesce(p_watched_at, now())
  )
  on conflict (profile_id, source_id, item_type, item_id)
  do update set
    user_id = excluded.user_id,
    parent_item_id = coalesce(excluded.parent_item_id, cloud_watch_history.parent_item_id),
    item_name = coalesce(excluded.item_name, cloud_watch_history.item_name),
    progress_seconds = excluded.progress_seconds,
    duration_seconds = case
      when excluded.duration_seconds > 0 then excluded.duration_seconds
      else cloud_watch_history.duration_seconds
    end,
    completed = case
      when p_completed is not null then p_completed
      when excluded.progress_seconds >= 60 then false
      else cloud_watch_history.completed
    end,
    data = cloud_watch_history.data || excluded.data,
    watched_at = excluded.watched_at
  where cloud_watch_history.watched_at is null
     or excluded.watched_at >= cloud_watch_history.watched_at
  returning * into saved;

  -- ON CONFLICT ... DO UPDATE WHERE returns no row when it correctly rejects an
  -- older capture. Return the authoritative winner to both web and paired-device
  -- clients so every caller immediately converges on the same cloud position.
  if saved.id is null then
    select *
      into saved
      from public.cloud_watch_history
     where profile_id = p_profile_id
       and source_id is not distinct from p_source_id
       and item_type = p_item_type
       and item_id = p_item_id;
  end if;

  return next saved;
end;
$$;

revoke all on function public.upsert_cloud_watch_history_causal(
  uuid, uuid, uuid, text, text, text, text, integer, integer, boolean, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.upsert_cloud_watch_history_causal(
  uuid, uuid, uuid, text, text, text, text, integer, integer, boolean, jsonb, timestamptz
) to service_role;

notify pgrst, 'reload schema';

commit;
