begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The notification outbox terminal success state is `delivered`. The original
-- dashboard queried an impossible legacy state (`completed`) and therefore
-- under-counted every sent notification.
create or replace function public.norva_provider_access_analytics_dashboard(
  p_window_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_since timestamptz;
  v_access jsonb;
  v_restoration jsonb;
  v_replacement jsonb;
  v_notifications jsonb;
  v_flags jsonb;
  v_staging_visibility_violations bigint;
begin
  if p_window_days is null or p_window_days < 1 or p_window_days > 90 then
    raise exception 'analytics window must be between 1 and 90 days'
      using errcode = '22023';
  end if;
  v_since := clock_timestamp() - make_interval(days => p_window_days);

  select jsonb_build_object(
    'sources_with_access_date', count(*) filter (where access.provider_access_expires_on is not null),
    'provider_reported_expiry', count(*) filter (where access.provider_access_expiry_source = 'provider_reported'),
    'user_entered_expiry', count(*) filter (where access.provider_access_expiry_source = 'user_entered'),
    'expected_expired', count(*) filter (where access.provider_access_status = 'expected_expired'),
    'confirmed_expired', count(*) filter (where access.provider_access_status in ('expired_confirmed','access_unavailable_confirmed')),
    'access_restored', count(*) filter (where access.provider_access_restored_at is not null)
  ) into v_access
  from public.cloud_source_provider_access access;

  select jsonb_build_object(
    'current_access_extended', count(*) filter (
      where event.event_kind = 'provider_access_cycle_extended'
    ),
    'new_credentials_submitted', count(*) filter (
      where event.event_kind = 'credential_transition_created'
    ),
    'credential_swaps_completed', count(*) filter (
      where event.event_kind = 'credential_transition_completed'
    ),
    'credential_swaps_rolled_back', count(*) filter (
      where event.event_kind = 'credential_compensation_completed'
    )
  ) into v_restoration
  from public.cloud_source_lifecycle_events event
  where event.occurred_at >= v_since;

  select v_restoration || jsonb_build_object(
    'same_catalog_detected', count(*) filter (where transition.identity_decision = 'same_catalog'),
    'different_catalog_detected', count(*) filter (where transition.identity_decision = 'different_catalog'),
    'ambiguous_catalog', count(*) filter (where transition.identity_decision = 'ambiguous')
  ) into v_restoration
  from public.cloud_source_transitions transition
  where transition.started_at >= v_since;

  select jsonb_build_object(
    'replacements_started', count(*) filter (where transition.transition_kind = 'replacement'),
    'completed', count(*) filter (where transition.transition_kind = 'replacement' and transition.state = 'completed'),
    'failed', count(*) filter (where transition.transition_kind = 'replacement' and transition.state = 'failed'),
    'cancelled', count(*) filter (where transition.transition_kind = 'replacement' and transition.state = 'cancelled')
  ) into v_replacement
  from public.cloud_source_transitions transition
  where transition.started_at >= v_since;

  select v_replacement || jsonb_build_object(
    'cleanup_pending', count(*) filter (where cleanup.state = 'pending')
  ) into v_replacement
  from public.cloud_source_replacement_cleanup_jobs cleanup;

  select count(*) into v_staging_visibility_violations
  from (
    select lifecycle.source_id
    from public.cloud_source_lifecycle lifecycle
    where lifecycle.lifecycle_state = 'staging'
      and lifecycle.catalog_visibility <> 'hidden'
    union
    select transition.candidate_source_id
    from public.cloud_source_transitions transition
    join public.cloud_source_lifecycle lifecycle
      on lifecycle.source_id = transition.candidate_source_id
     and lifecycle.user_id = transition.user_id
    where transition.transition_kind = 'replacement'
      and transition.state not in ('completed','failed','cancelled')
      and lifecycle.catalog_visibility <> 'hidden'
  ) violation;
  v_replacement := v_replacement || jsonb_build_object(
    'staging_visibility_violation', v_staging_visibility_violations
  );

  select jsonb_build_object(
    '7d_sent', count(distinct notification.access_cycle_id) filter (
      where notification.event_kind = 'expiry_7d' and notification.state = 'delivered'
    ),
    '1d_sent', count(distinct notification.access_cycle_id) filter (
      where notification.event_kind = 'expiry_1d' and notification.state = 'delivered'
    ),
    'today_sent', count(distinct notification.access_cycle_id) filter (
      where notification.event_kind = 'expiry_today' and notification.state = 'delivered'
    ),
    'superseded', count(*) filter (where notification.state = 'superseded'),
    'dead_letter', count(*) filter (where notification.state = 'dead_letter'),
    'push_delivered', count(*) filter (
      where notification.channel = 'push' and notification.state = 'delivered'
    ),
    'email_delivered', count(*) filter (
      where notification.channel = 'email' and notification.state = 'delivered'
    )
  ) into v_notifications
  from public.cloud_provider_access_notifications notification
  where notification.created_at >= v_since;

  select coalesce(jsonb_object_agg(flag.key, flag.enabled order by flag.key), '{}'::jsonb)
  into v_flags
  from public.admin_feature_flags flag
  where flag.key in (
    'provider_access_v1_enabled',
    'provider_access_auto_detection_v1_enabled',
    'provider_access_notifications_v1_enabled',
    'provider_access_email_v1_enabled',
    'provider_access_push_v1_enabled',
    'provider_access_in_app_v1_enabled',
    'provider_access_visibility_v1_enabled',
    'provider_credential_transition_v1_enabled',
    'provider_replacement_v1_enabled'
  );

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', clock_timestamp(),
    'windowDays', p_window_days,
    'windowStart', v_since,
    'access', v_access,
    'restoration', v_restoration,
    'replacement', v_replacement,
    'notifications', v_notifications,
    'flags', v_flags,
    'p0', jsonb_build_object(
      'active', v_staging_visibility_violations > 0,
      'code', case when v_staging_visibility_violations > 0 then 'STAGING_VISIBILITY_VIOLATION' else null end,
      'severity', case when v_staging_visibility_violations > 0 then 'P0' else null end,
      'count', v_staging_visibility_violations
    )
  );
end
$function$;

revoke all on function public.norva_provider_access_analytics_dashboard(integer)
  from public, anon, authenticated;
grant execute on function public.norva_provider_access_analytics_dashboard(integer)
  to service_role;

comment on function public.norva_provider_access_analytics_dashboard(integer) is
  'Phase 15 aggregate-only Provider Access dashboard; delivered is the canonical successful outbox state.';

commit;
