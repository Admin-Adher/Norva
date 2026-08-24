\set ON_ERROR_STOP on
\timing on

-- A LIMIT on cloud_playback_sessions is not a bound while one session owns a
-- large permit, gateway, relay-token, or event history.  Seed 100k rows for
-- each child family, run the real playback phase with a one-row budget, and
-- prove that exactly one child is handled while the parent remains present.

begin;
set local lock_timeout = '2s';
set local statement_timeout = '8min';
set local "request.jwt.claim.role" = 'service_role';

create or replace procedure pg_temp.norva_playback_child_bound(
  p_kind text,
  p_scale integer default 100000
)
language plpgsql
as $procedure$
declare
  v_user uuid := md5('account-delete-playback-user-' || p_kind)::uuid;
  v_source uuid := md5('account-delete-playback-source-' || p_kind)::uuid;
  v_playback uuid := md5('account-delete-playback-parent-' || p_kind)::uuid;
  v_event uuid := md5('account-delete-playback-event-' || p_kind)::uuid;
  v_relation text;
  v_filter_column text;
  v_filter_value uuid;
  v_prepare jsonb;
  v_claim jsonb;
  v_run jsonb;
  v_remaining bigint;
begin
  if p_kind not in ('permit','gateway','relay','event','paywall') then
    raise exception 'unsupported playback child family %', p_kind;
  end if;
  v_relation := case p_kind
    when 'permit' then 'cloud_provider_call_permits'
    when 'gateway' then 'cloud_gateway_sessions'
    when 'relay' then 'cloud_relay_tokens'
    when 'event' then 'cloud_playback_events'
    else 'paywall_funnel_events'
  end;
  v_filter_column := case when p_kind = 'paywall'
    then 'playback_event_id' else 'playback_session_id' end;
  v_filter_value := case when p_kind = 'paywall'
    then v_event else v_playback end;

  insert into auth.users (
    id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
    raw_app_meta_data,raw_user_meta_data,created_at,updated_at
  ) values (
    v_user,'00000000-0000-0000-0000-000000000000',
    'authenticated','authenticated',
    'account-delete-playback-' || p_kind || '@invalid.test','',now(),
    '{}'::jsonb,'{}'::jsonb,now(),now()
  );
  insert into public.cloud_sources (
    id,user_id,source_type,display_name,config_ciphertext,config_hint,
    sync_status,catalog_version,enabled,last_synced_at
  ) values (
    v_source,v_user,'xtream','Playback ' || p_kind || ' child bound',
    'cipher-playback-' || p_kind,'{}'::jsonb,'ready',1,true,now()
  );
  insert into public.cloud_playback_sessions (
    id,user_id,source_id,item_type,item_id,mode,status,expires_at
  ) values (
    v_playback,v_user,v_source,'movie','playback-' || p_kind,
    'direct','expired',clock_timestamp() - interval '1 hour'
  );
  if p_kind = 'paywall' then
    insert into public.cloud_playback_events (
      id,user_id,playback_session_id,source_id,item_type,item_id,event_type
    ) values (
      v_event,v_user,v_playback,v_source,'movie','playback-paywall','ended'
    );
  end if;

  if p_kind = 'permit' then
    insert into public.cloud_provider_call_permits (
      id,user_id,source_id,playback_session_id,permit_token,permit_owner,
      authorization_kind,expected_account_deletion_epoch,
      expected_source_deletion_epoch,max_http_timeout_ms,max_response_bytes,
      operation_kind,state,acquired_at,permit_until,released_at
    )
    select md5('playback-permit-child-' || ordinal::text)::uuid,
      v_user,v_source,v_playback,
      md5('playback-permit-token-' || ordinal::text)::uuid,
      'playback-child-bound','playback',0,0,1000,1024,
      'playback_stream','released',
      clock_timestamp() - interval '2 hours',
      clock_timestamp() - interval '1 hour',
      clock_timestamp() - interval '1 hour'
    from generate_series(1,p_scale) ordinal;
  elsif p_kind = 'gateway' then
    insert into public.cloud_gateway_sessions (
      id,user_id,playback_session_id,mode,status,expires_at
    )
    select md5('playback-gateway-child-' || ordinal::text)::uuid,
      v_user,v_playback,'remux','ended',
      clock_timestamp() - interval '1 hour'
    from generate_series(1,p_scale) ordinal;
  elsif p_kind = 'relay' then
    insert into public.cloud_relay_tokens (
      id,user_id,playback_session_id,token_hash,expires_at,revoked_at
    )
    select md5('playback-relay-child-' || ordinal::text)::uuid,
      v_user,v_playback,md5('playback-relay-token-' || ordinal::text),
      clock_timestamp() - interval '1 hour',clock_timestamp()
    from generate_series(1,p_scale) ordinal;
  elsif p_kind = 'event' then
    insert into public.cloud_playback_events (
      id,user_id,playback_session_id,source_id,item_type,item_id,event_type
    )
    select md5('playback-event-child-' || ordinal::text)::uuid,
      v_user,v_playback,v_source,'movie',
      'playback-event-' || ordinal::text,'ended'
    from generate_series(1,p_scale) ordinal;
  else
    insert into public.paywall_funnel_events (
      id,user_id,event_type,event_source,playback_event_id,dedupe_key
    )
    select md5('playback-paywall-child-' || ordinal::text)::uuid,
      v_user,'first_play','playback_first_frame',v_event,
      'playback-paywall-child-' || ordinal::text
    from generate_series(1,p_scale) ordinal;
  end if;

  execute format(
    'select count(*) from public.%I where %I = $1',
    v_relation,v_filter_column
  ) into v_remaining using v_filter_value;
  if v_remaining <> p_scale then
    raise exception '% playback child scale fixture is incomplete: %',
      p_kind,v_remaining;
  end if;

  v_prepare := public.norva_begin_provider_account_deletion_prepare(v_user);
  v_claim := public.norva_claim_provider_account_deletion_prepare(
    v_user,'playback-child-' || p_kind,300
  );
  update public.cloud_provider_account_delete_preparations
  set phase = 'playback'
  where user_id = v_user;
  v_run := public.norva_run_provider_account_deletion_prepare_batch(
    v_user,'playback-child-' || p_kind,
    (v_claim->>'leaseSequence')::integer,
    (v_claim->>'revision')::bigint,1
  );

  execute format(
    'select count(*) from public.%I where %I = $1',
    v_relation,v_filter_column
  ) into v_remaining using v_filter_value;
  if v_remaining <> p_scale - 1
     or not exists (
       select 1 from public.cloud_playback_sessions where id = v_playback
     )
     or (p_kind = 'paywall' and (
       not exists (
         select 1 from public.cloud_playback_events where id = v_event
       )
       or (v_run->>'batchMutatedRows')::bigint <> 1
       or (v_run->>'deletedRows')::bigint <> 0
     ))
     or (p_kind <> 'paywall' and (v_run->>'deletedRows')::bigint <> 1) then
    raise exception '% playback child deletion exceeded the one-row budget (remaining %, response %)',
      p_kind,v_remaining,v_run;
  end if;
end
$procedure$;

call pg_temp.norva_playback_child_bound('permit');
call pg_temp.norva_playback_child_bound('gateway');
call pg_temp.norva_playback_child_bound('relay');
call pg_temp.norva_playback_child_bound('event');
call pg_temp.norva_playback_child_bound('paywall');

-- Emit reproducible buffer plans for both the account/user keyset and the
-- parent-session keyset used by the source reaper.  With 99,999 rows left in
-- each family these must remain title/session-index driven rather than scan
-- the high-cardinality history.
explain (analyze,buffers,costs off)
select permit.id
from public.cloud_provider_call_permits permit
where permit.user_id = md5('account-delete-playback-user-permit')::uuid
order by permit.id limit 1 for update;
explain (analyze,buffers,costs off)
select permit.id
from public.cloud_provider_call_permits permit
where permit.playback_session_id =
  md5('account-delete-playback-parent-permit')::uuid
order by permit.id limit 1 for update;

explain (analyze,buffers,costs off)
select gateway.id
from public.cloud_gateway_sessions gateway
where gateway.user_id = md5('account-delete-playback-user-gateway')::uuid
order by gateway.id limit 1 for update;
explain (analyze,buffers,costs off)
select gateway.id
from public.cloud_gateway_sessions gateway
where gateway.playback_session_id =
  md5('account-delete-playback-parent-gateway')::uuid
order by gateway.id limit 1 for update;

explain (analyze,buffers,costs off)
select relay.id
from public.cloud_relay_tokens relay
where relay.user_id = md5('account-delete-playback-user-relay')::uuid
order by relay.id limit 1 for update;
explain (analyze,buffers,costs off)
select relay.id
from public.cloud_relay_tokens relay
where relay.playback_session_id =
  md5('account-delete-playback-parent-relay')::uuid
order by relay.id limit 1 for update;

explain (analyze,buffers,costs off)
select event.id
from public.cloud_playback_events event
where event.user_id = md5('account-delete-playback-user-event')::uuid
order by event.id limit 1 for update;
explain (analyze,buffers,costs off)
select event.id
from public.cloud_playback_events event
where event.playback_session_id =
  md5('account-delete-playback-parent-event')::uuid
order by event.id limit 1 for update;

explain (analyze,buffers,costs off)
select paywall.id
from public.paywall_funnel_events paywall
where paywall.playback_event_id =
  md5('account-delete-playback-event-paywall')::uuid
order by paywall.id limit 1 for update;

rollback;
