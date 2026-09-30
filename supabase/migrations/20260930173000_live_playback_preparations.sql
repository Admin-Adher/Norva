begin;

-- A short-lived server receipt, not a provider grant. Only the service lane
-- accesses this ledger; ownership/device checks are repeated in every RPC.
create table public.live_playback_preparations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null,
  device_id uuid,
  item_id text not null check (length(item_id) between 1 and 512),
  requested_mode text,
  gateway_generations jsonb not null,
  started_at timestamptz,
  settled_at timestamptz,
  playback_session_id uuid not null unique default gen_random_uuid(),
  state text not null default 'prepared' check (state in ('prepared','creating','finished','cancel_requested','cancelled')),
  expires_at timestamptz not null default (clock_timestamp() + interval '180 seconds'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index live_playback_preparations_owner_expiry on public.live_playback_preparations(user_id, expires_at);
alter table public.live_playback_preparations enable row level security;
revoke all on public.live_playback_preparations from public, anon, authenticated;
grant select, insert, update, delete on public.live_playback_preparations to service_role;

create function public.norva_prepare_live_playback(p_user_id uuid, p_source_id uuid,
  p_device_id uuid, p_item_id text, p_mode text, p_gateway_generations jsonb)
returns public.live_playback_preparations language plpgsql security definer set search_path = '' as $$
declare v_row public.live_playback_preparations; v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null or p_source_id is null or length(coalesce(p_item_id,'')) not between 1 and 512
    or (p_mode is not null and p_mode not in ('auto','direct','engine','relay','transcode')) then
    raise exception 'invalid live preparation' using errcode='22023';
  end if;
  if p_gateway_generations is null or jsonb_typeof(p_gateway_generations)<>'object'
    or (select count(*) from jsonb_each(p_gateway_generations)) not between 1 and 2
    or exists(select 1 from jsonb_each_text(p_gateway_generations) e
      where e.key !~ '^[0-9a-f]{64}$' or e.value !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') then
    raise exception 'invalid preparation gateway generation' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('live-preparation:'||p_user_id::text,0));
  if not exists(select 1 from public.cloud_sources where id=p_source_id and user_id=p_user_id)
    or (p_device_id is not null and not exists(select 1 from public.cloud_devices
      where id=p_device_id and user_id=p_user_id and revoked=false)) then
    raise exception 'live preparation ownership denied' using errcode='42501';
  end if;
  -- Terminal rows are retained long enough to reject delayed retries. A stuck
  -- active producer is never deleted here or treated as drained by a TTL.
  delete from public.live_playback_preparations where user_id=p_user_id
    and ((state in ('cancelled','finished') and updated_at<v_now-interval '1 day')
      or (state='prepared' and expires_at<v_now-interval '1 day'));
  if (select count(*) from public.live_playback_preparations where user_id=p_user_id
      and state in ('prepared','creating','cancel_requested') and expires_at>v_now)>=16
    or (select count(*) from public.live_playback_preparations where user_id=p_user_id
      and created_at>v_now-interval '1 minute')>=60 then
    raise exception 'live preparation capacity reached' using errcode='54000';
  end if;
  insert into public.live_playback_preparations(user_id,source_id,device_id,item_id,requested_mode,gateway_generations)
    values(p_user_id,p_source_id,p_device_id,p_item_id,p_mode,p_gateway_generations) returning * into v_row;
  return v_row;
end $$;

create function public.norva_begin_live_preparation(p_id uuid,p_user_id uuid,p_device_id uuid,
  p_source_id uuid,p_item_id text,p_mode text)
returns public.live_playback_preparations language plpgsql security definer set search_path = '' as $$
declare v_row public.live_playback_preparations;
begin
  select * into v_row from public.live_playback_preparations where id=p_id for update;
  if not found or v_row.user_id is distinct from p_user_id or v_row.device_id is distinct from p_device_id
    or v_row.source_id is distinct from p_source_id or v_row.item_id is distinct from p_item_id
    or (v_row.requested_mode is not null and v_row.requested_mode is distinct from p_mode) then
    raise exception 'live preparation scope denied' using errcode='42501';
  end if;
  if v_row.state<>'prepared' or v_row.expires_at<=clock_timestamp() then
    raise exception 'live preparation no longer available' using errcode='55000';
  end if;
  update public.live_playback_preparations set state='creating',started_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=p_id returning * into v_row;
  return v_row;
end $$;

create function public.norva_cancel_live_preparation(p_id uuid,p_user_id uuid,p_device_id uuid)
returns public.live_playback_preparations language plpgsql security definer set search_path = '' as $$
declare v_row public.live_playback_preparations;
begin
  select * into v_row from public.live_playback_preparations where id=p_id for update;
  if not found or v_row.user_id is distinct from p_user_id or v_row.device_id is distinct from p_device_id then
    raise exception 'live preparation scope denied' using errcode='42501';
  end if;
  if v_row.state<>'cancelled' then
    update public.live_playback_preparations set state='cancel_requested',updated_at=clock_timestamp()
      where id=p_id returning * into v_row;
  end if;
  return v_row;
end $$;

-- The preparation lock and provider claim share one transaction. A cancellation
-- winning this lock prevents an old request from superseding a later Play.
create function public.claim_prepared_cloud_playback_session(
  p_preparation_id uuid,p_session_id uuid,p_user_id uuid,p_source_id uuid,p_device_id uuid,
  p_item_type text,p_item_id text,p_mode text,p_status text,p_target_url_hash text,
  p_provider_account_hash text,p_stream_mime text,p_playback_hint jsonb,p_expires_at timestamptz)
returns table(new_session_id uuid,superseded_session_ids uuid[])
language plpgsql security definer set search_path = '' as $$
declare v_row public.live_playback_preparations;
begin
  select * into v_row from public.live_playback_preparations where id=p_preparation_id for update;
  if not found or v_row.user_id is distinct from p_user_id or v_row.device_id is distinct from p_device_id
    or v_row.source_id is distinct from p_source_id or v_row.item_id is distinct from p_item_id
    or p_item_type is distinct from 'live' or v_row.playback_session_id is distinct from p_session_id then
    raise exception 'live preparation scope denied' using errcode='42501';
  end if;
  if v_row.state<>'creating' or v_row.expires_at<=clock_timestamp()
    or exists(select 1 from public.cloud_playback_sessions where id=p_session_id) then
    raise exception 'live preparation no longer available' using errcode='55000';
  end if;
  return query select * from public.claim_cloud_playback_session(p_session_id,p_user_id,
    p_source_id,p_device_id,p_item_type,p_item_id,p_mode,p_status,p_target_url_hash,
    p_provider_account_hash,p_stream_mime,p_playback_hint,p_expires_at);
end $$;

revoke all on function public.norva_prepare_live_playback(uuid,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.norva_begin_live_preparation(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.norva_cancel_live_preparation(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.claim_prepared_cloud_playback_session(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.norva_prepare_live_playback(uuid,uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.norva_begin_live_preparation(uuid,uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.norva_cancel_live_preparation(uuid,uuid,uuid) to service_role;
grant execute on function public.claim_prepared_cloud_playback_session(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,jsonb,timestamptz) to service_role;
commit;
