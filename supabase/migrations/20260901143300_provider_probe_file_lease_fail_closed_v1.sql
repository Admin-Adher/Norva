begin;

-- A Gateway account_busy/background_busy response is produced before ffprobe is
-- spawned. The repair worker has already crossed its attempt boundary at that
-- point, so undo exactly that token's provisional attempt and defer it without
-- letting local backpressure consume the four-attempt provider budget.
create or replace function public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(
  p_user uuid,
  p_source uuid,
  p_variant uuid,
  p_lease_token uuid,
  p_reason text,
  p_retry_seconds integer default 30
) returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_cohort_id uuid;
  v_now timestamptz := clock_timestamp();
  v_cancelled boolean := false;
begin
  if p_user is null or p_source is null or p_variant is null
     or p_lease_token is null
     or p_retry_seconds is null
     or p_retry_seconds not between 1 and 900 then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-repair:' || p_user::text || ':' || p_source::text,
    0
  ));

  perform 1
  from public.cloud_sources source
  where source.user_id = p_user
    and source.id = p_source
  for share;
  if not found then
    return false;
  end if;

  select cohort.id into v_cohort_id
  from public.catalog_file_audio_repair_cohorts cohort
  join public.catalog_file_audio_repair_items item
    on item.cohort_id = cohort.id
   and item.user_id = cohort.user_id
   and item.source_id = cohort.source_id
  where cohort.user_id = p_user
    and cohort.source_id = p_source
    and cohort.state = 'active'
    and item.variant_id = p_variant
    and item.state = 'leased'
    and item.lease_token = p_lease_token
    and item.lease_attempt_started
    and item.attempt_count > 0
  for update of cohort;
  if not found then
    return false;
  end if;

  update public.catalog_file_audio_repair_items item
     set state = 'pending',
         attempt_count = greatest(0, item.attempt_count - 1),
         lease_token = null,
         lease_attempt_started = false,
         lease_until = null,
         next_attempt_at = v_now + make_interval(secs => p_retry_seconds),
         last_error = left(coalesce(
           nullif(btrim(p_reason), ''),
           'provider-pre-spawn-rejected'
         ), 160),
         updated_at = v_now
   where item.cohort_id = v_cohort_id
     and item.user_id = p_user
     and item.source_id = p_source
     and item.variant_id = p_variant
     and item.state = 'leased'
     and item.lease_token = p_lease_token
     and item.lease_attempt_started
     and item.attempt_count > 0
  returning true into v_cancelled;

  return coalesce(v_cancelled, false);
end
$function$;

revoke all on function public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(
  uuid, uuid, uuid, uuid, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.norva_cancel_catalog_file_audio_repair_pre_spawn_attempt(
  uuid, uuid, uuid, uuid, text, integer
) to service_role;

notify pgrst, 'reload schema';

commit;
