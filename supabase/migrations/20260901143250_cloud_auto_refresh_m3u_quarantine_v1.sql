-- A durable M3U import quarantine is already the result of four bounded
-- provider attempts. The fair auto-refresh scheduler must be able to settle
-- that state as an explicit user action instead of leaking its claim until TTL.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create or replace function public.norva_settle_cloud_auto_refresh_source(
  p_source_id uuid,
  p_user_id uuid,
  p_worker text,
  p_expected_lease_sequence bigint,
  p_outcome text,
  p_observed_at timestamptz default now(),
  p_http_status integer default null,
  p_error_kind text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_source public.cloud_sources%rowtype;
  v_state jsonb;
  v_clean jsonb;
  v_next_at timestamptz;
  v_attempts integer;
  v_terminal_count integer;
  v_same_terminal boolean;
  v_suspended boolean;
  v_action text;
begin
  perform public.norva_provider_access_service_role_required();
  if p_source_id is null or p_user_id is null
     or p_worker is null or btrim(p_worker) = '' or length(p_worker) > 200
     or p_expected_lease_sequence is null or p_expected_lease_sequence < 1
     or p_outcome is null
     or p_outcome not in ('success', 'not_entitled', 'transient_failure', 'action_required')
     or p_observed_at is null or p_observed_at > clock_timestamp() + interval '5 minutes'
     or (
       p_outcome = 'action_required'
       and (
         p_http_status is null
         or p_error_kind is null
         or not (
           (p_http_status = 409 and p_error_kind = 'm3u_quarantined')
           or (p_http_status = 404 and p_error_kind = 'not_found')
           or (p_http_status in (401, 403) and p_error_kind in ('auth', 'expired'))
         )
       )
     )
     or (
       p_outcome = 'transient_failure'
       and (p_error_kind is null or p_error_kind not in ('busy', 'infra', 'unknown'))
     )
     or (
       p_outcome in ('success', 'not_entitled')
       and (p_http_status is not null or p_error_kind is not null)
     ) then
    raise exception 'invalid cloud auto refresh settlement' using errcode = '22023';
  end if;

  select source.* into v_source
  from public.cloud_sources source
  where source.id = p_source_id and source.user_id = p_user_id
  for update;

  if not found then
    raise exception 'cloud auto refresh lease is stale' using errcode = 'PT409';
  end if;

  if v_source.auto_refresh_lease_owner is distinct from p_worker
     or v_source.auto_refresh_lease_sequence is distinct from p_expected_lease_sequence
     or v_source.auto_refresh_lease_expires_at is null
     or v_source.auto_refresh_lease_expires_at <= clock_timestamp() then
    raise exception 'cloud auto refresh lease is stale' using errcode = 'PT409';
  end if;

  v_state := coalesce(v_source.auto_refresh_state, '{}'::jsonb);
  v_clean := v_state - array[
    'lockedAt', 'backoffUntil', 'lastClaimedAt', 'lastCompletedAt',
    'lastOutcome', 'lastHttpStatus', 'lastErrorKind'
  ];

  if p_outcome = 'success' then
    v_next_at := p_observed_at + interval '6 hours';
    v_clean := v_clean - array[
      'actionRequired', 'actionRequiredReason', 'terminalHttpStatus',
      'terminalErrorKind', 'terminalFailureCount', 'terminalFirstAt',
      'terminalLastAt', 'suspended'
    ];
    v_state := v_clean || jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'success',
      'lastCompletedAt', p_observed_at
    );
  elsif p_outcome = 'not_entitled' then
    v_next_at := p_observed_at + interval '6 hours';
    v_state := v_clean || jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'not_entitled',
      'lastCompletedAt', p_observed_at
    );
  elsif p_outcome = 'transient_failure' then
    v_attempts := least(20, (
      case
        when coalesce(v_state ->> 'attempts', '') ~ '^[0-9]{1,2}$'
          then (v_state ->> 'attempts')::integer
        else 0
      end
    ) + 1);
    v_next_at := p_observed_at + make_interval(
      secs => least(21600, (300 * power(2::numeric, least(v_attempts, 6)))::integer)
    );
    v_state := v_clean || jsonb_build_object(
      'attempts', v_attempts,
      'lastOutcome', 'transient_failure',
      'lastErrorKind', p_error_kind,
      'lastCompletedAt', p_observed_at,
      'backoffUntil', v_next_at
    );
  else
    v_same_terminal := v_state ->> 'terminalHttpStatus' is not distinct from p_http_status::text
      and v_state ->> 'terminalErrorKind' is not distinct from p_error_kind;
    v_terminal_count := case
      when v_same_terminal then least(20, (
        case
          when coalesce(v_state ->> 'terminalFailureCount', '') ~ '^[0-9]{1,2}$'
            then (v_state ->> 'terminalFailureCount')::integer
          else 0
        end
      ) + 1)
      else 1
    end;
    -- Quarantine is already the fourth bounded provider failure. Suspend it
    -- immediately; another confirmation tick cannot recover the source.
    v_suspended := p_error_kind = 'm3u_quarantined' or v_terminal_count >= 2;
    v_action := case
      when p_error_kind = 'm3u_quarantined' then 'TOGGLE_SOURCE'
      when p_error_kind = 'expired' then 'RENEW_ACCESS'
      when p_error_kind = 'auth' then 'UPDATE_LOGIN'
      else 'CHECK_PROVIDER'
    end;
    v_next_at := p_observed_at + case when v_suspended then interval '30 days' else interval '24 hours' end;
    v_state := v_clean || jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'action_required',
      'lastHttpStatus', p_http_status,
      'lastErrorKind', p_error_kind,
      'lastCompletedAt', p_observed_at,
      'actionRequired', true,
      'actionRequiredReason', v_action,
      'terminalHttpStatus', p_http_status,
      'terminalErrorKind', p_error_kind,
      'terminalFailureCount', v_terminal_count,
      'terminalFirstAt', case
        when v_same_terminal then coalesce(v_state -> 'terminalFirstAt', to_jsonb(p_observed_at))
        else to_jsonb(p_observed_at)
      end,
      'terminalLastAt', p_observed_at,
      'suspended', v_suspended
    );
  end if;

  update public.cloud_sources source
  set auto_refresh_lease_owner = null,
      auto_refresh_lease_expires_at = null,
      auto_refresh_next_at = v_next_at,
      auto_refresh_state = v_state
  where source.id = p_source_id
    and source.user_id = p_user_id
    and source.auto_refresh_lease_owner = p_worker
    and source.auto_refresh_lease_sequence = p_expected_lease_sequence;
  if not found then
    raise exception 'cloud auto refresh lease is stale' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'sourceId', p_source_id,
    'outcome', p_outcome,
    'nextAt', v_next_at,
    'actionRequired', coalesce(v_state ->> 'actionRequired' = 'true', false),
    'suspended', coalesce(v_state ->> 'suspended' = 'true', false),
    'terminalFailureCount', case
      when coalesce(v_state ->> 'terminalFailureCount', '') ~ '^[0-9]{1,2}$'
        then (v_state ->> 'terminalFailureCount')::integer
      else 0
    end
  );
end
$function$;

revoke all on function public.norva_settle_cloud_auto_refresh_source(
  uuid,uuid,text,bigint,text,timestamptz,integer,text
) from public, anon, authenticated;
grant execute on function public.norva_settle_cloud_auto_refresh_source(
  uuid,uuid,text,bigint,text,timestamptz,integer,text
) to service_role;

comment on function public.norva_settle_cloud_auto_refresh_source(
  uuid,uuid,text,bigint,text,timestamptz,integer,text
) is 'Settles a fenced fair-refresh claim, including immediate user-action suspension for a quarantined M3U import.';

commit;
