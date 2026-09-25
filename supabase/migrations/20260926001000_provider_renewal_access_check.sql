-- A healthy credential swap still needs a fresh provider access observation.
-- Keep the daily check and its history; schedule a distinct renewal check.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create index if not exists cloud_source_transitions_completed_credentials_idx
  on public.cloud_source_transitions(user_id,old_source_id,expected_source_revision,completed_at desc)
  where transition_kind='credential' and state='completed';

create or replace function public.norva_schedule_provider_access_checks(
  p_limit integer default 100, p_now timestamptz default now()
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  v_scheduled integer := 0;
begin
  perform public.norva_provider_access_capability_required('provider_access_v1_enabled');
  perform public.norva_provider_access_capability_required('provider_access_auto_detection_v1_enabled');
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_now is null then
    raise exception 'invalid Provider Access scheduling bound' using errcode = '22023';
  end if;

  insert into public.cloud_provider_access_check_jobs (
    user_id, source_id, state, next_attempt_at, idempotency_key
  )
  select source.user_id, source.id, 'queued', p_now,
    case when renewal.id is not null then
      'provider-access-renewal:' || source.id::text || ':' || renewal.id::text
    else 'provider-access-check:' || source.id::text end
      || ':' || to_char(p_now at time zone 'UTC', 'YYYY-MM-DD')
  from public.cloud_sources source
  join public.cloud_source_lifecycle lifecycle
    on lifecycle.source_id = source.id and lifecycle.user_id = source.user_id
  join public.cloud_source_provider_access access
    on access.source_id = source.id and access.user_id = source.user_id
  left join lateral (
    select transition.id
    from public.cloud_source_transitions transition
    where transition.user_id=source.user_id and transition.old_source_id=source.id
      and transition.transition_kind='credential' and transition.state='completed'
      and transition.expected_source_revision=lifecycle.config_revision-1
      and transition.completed_at is not null and transition.completed_at<=p_now
      and (access.provider_access_last_checked_at is null
        or access.provider_access_last_checked_at<transition.completed_at)
    order by transition.completed_at desc,transition.id
    limit 1
  ) renewal on true
  where source.source_type = 'xtream'
    and source.enabled and source.deleted_at is null
    and lifecycle.lifecycle_state = 'active'
    and (
      renewal.id is not null
      or access.provider_access_status = 'restoring'
      or access.provider_access_last_checked_at is null
      or access.provider_access_last_checked_at <= p_now - interval '24 hours'
    )
    and not exists (
      select 1 from public.cloud_provider_access_check_jobs open_job
      where open_job.source_id = source.id and open_job.state in ('queued','leased','retry')
    )
  order by (renewal.id is not null) desc,access.provider_access_last_checked_at nulls first,source.id
  limit p_limit
  on conflict do nothing;
  get diagnostics v_scheduled = row_count;
  return jsonb_build_object('scheduled', v_scheduled, 'limit', p_limit);
end
$function$;
revoke all on function public.norva_schedule_provider_access_checks(integer,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.norva_schedule_provider_access_checks(integer,timestamptz) to service_role;
commit;
