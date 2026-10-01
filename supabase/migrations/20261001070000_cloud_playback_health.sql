-- Playback health is owner-local evidence, never a provider-global availability
-- verdict. Bind it to the server-created session and source configuration.
alter table public.cloud_playback_sessions
  add column health_source_revision bigint;

create function public.norva_bind_playback_health_revision()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select l.config_revision into new.health_source_revision
  from public.cloud_source_lifecycle l
  where l.source_id = new.source_id and l.user_id = new.user_id
    and l.lifecycle_state = 'active' and l.catalog_visibility = 'visible';
  return new;
end;
$$;
revoke all on function public.norva_bind_playback_health_revision() from public, anon, authenticated;
create trigger playback_health_revision before insert on public.cloud_playback_sessions
for each row execute function public.norva_bind_playback_health_revision();

create table public.cloud_playback_health (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  source_revision bigint not null,
  item_type text not null check (item_type in ('movie', 'episode', 'channel')),
  item_id text not null,
  status text not null check (status in ('ok', 'broken')),
  failure_category text,
  session_id uuid not null,
  session_started_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (user_id, source_id, source_revision, item_type, item_id)
);
create index cloud_playback_health_owner_page on public.cloud_playback_health(user_id, id);
alter table public.cloud_playback_health enable row level security;
-- Access goes through the authenticated edge and narrow service RPCs only.
revoke all on public.cloud_playback_health from public, anon, authenticated;
grant select, insert, update, delete on public.cloud_playback_health to service_role;

create function public.norva_record_playback_health(
  p_user uuid, p_session uuid, p_status text, p_reason text default '', p_device uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.cloud_playback_sessions%rowtype;
  h public.cloud_playback_health%rowtype;
  revision bigint;
  media_type text;
  category text;
begin
  if p_status not in ('ok', 'broken') or p_status is null then
    raise exception 'INVALID_PLAYBACK_HEALTH_STATUS' using errcode = '22023';
  end if;
  select * into s from public.cloud_playback_sessions
    where id = p_session and user_id = p_user
      and (p_device is null or device_id = p_device);
  if not found then
    raise exception 'PLAYBACK_SESSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  select config_revision into revision from public.cloud_source_lifecycle
    where source_id = s.source_id and user_id = p_user
      and lifecycle_state = 'active' and catalog_visibility = 'visible' for share;
  -- Pre-migration sessions have no trustworthy snapshot. Do not backfill them
  -- with today's source revision or attach old-address failures to a new one.
  if revision is null or s.health_source_revision is distinct from revision then
    return jsonb_build_object('persisted', false, 'ignored', true, 'reason', 'source-revision-changed');
  end if;
  media_type := case s.item_type when 'movie' then 'movie'
    when 'series' then 'episode' when 'episode' then 'episode'
    when 'live' then 'channel' when 'channel' then 'channel' end;
  if media_type is null or coalesce(s.item_id, '') = '' then
    return jsonb_build_object('persisted', false, 'ignored', true, 'reason', 'unsupported-session-target');
  end if;
  -- Persist categories only: provider messages can contain signed URLs/passwords.
  category := case when p_status = 'ok' then null
    when p_reason ~* '(401|403|unauthori[sz]ed|forbidden|credential)' then 'access'
    when p_reason ~* '(429|458|busy|connection.limit|one.connection)' then 'busy'
    when p_reason ~* '(codec|decoder|unsupported|format|demux)' then 'format'
    when p_reason ~* '(timeout|network|econn|dns|502|503|504)' then 'network'
    else 'playback' end;
  insert into public.cloud_playback_health as current
    (user_id,source_id,source_revision,item_type,item_id,status,failure_category,session_id,session_started_at)
  values (p_user,s.source_id,revision,media_type,s.item_id,p_status,category,s.id,s.created_at)
  on conflict (user_id,source_id,source_revision,item_type,item_id) do update
    set status = excluded.status, failure_category = excluded.failure_category,
        session_id = excluded.session_id, session_started_at = excluded.session_started_at, updated_at = now()
    -- Arrival order is not playback order. A decoded first frame also wins
    -- over an earlier startup failure arriving late within the same session.
    where (excluded.session_started_at, excluded.session_id) > (current.session_started_at, current.session_id)
       or (excluded.session_id = current.session_id and current.status <> 'ok')
  returning * into h;
  if h.id is null then
    return jsonb_build_object('persisted', false, 'ignored', true, 'reason', 'superseded');
  end if;
  return jsonb_build_object('persisted', true, 'entry', jsonb_build_object(
    'source_id',h.source_id,'item_type',h.item_type,'item_id',h.item_id,
    'status',h.status,'last_error',h.failure_category,'updated_at',h.updated_at,
    'source_revision',h.source_revision,'unavailable',false));
end;
$$;
revoke all on function public.norva_record_playback_health(uuid,uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.norva_record_playback_health(uuid,uuid,text,text,uuid) to service_role;

create function public.norva_list_playback_health(
  p_user uuid, p_source uuid default null, p_type text default null, p_after uuid default null
) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('entries',coalesce(jsonb_agg(jsonb_build_object(
    'source_id',h.source_id,'item_type',h.item_type,'item_id',h.item_id,
    'status',h.status,'last_error',h.failure_category,'updated_at',h.updated_at,
    'source_revision',h.source_revision,'unavailable',false,'cursor',h.id
  ) order by h.id),'[]'::jsonb)) from (
    select h.* from public.cloud_playback_health h
    join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
      and l.config_revision=h.source_revision and l.lifecycle_state='active' and l.catalog_visibility='visible'
    where h.user_id=p_user and (p_source is null or h.source_id=p_source)
      and (p_type is null or h.item_type=p_type) and (p_after is null or h.id>p_after)
    order by h.id limit 500
  ) h;
$$;
revoke all on function public.norva_list_playback_health(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.norva_list_playback_health(uuid,uuid,text,uuid) to service_role;

-- Existing native/web events feed the same ledger without fabricating new
-- analytics events or requiring a new native binary. Only linked sessions count.
create function public.norva_project_playback_health_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.playback_session_id is not null
    and new.event_type in ('first_frame','playback_error','gateway_error')
    and exists(select 1 from public.cloud_playback_sessions s
      where s.id=new.playback_session_id and s.user_id=new.user_id
        and (new.device_id is null or s.device_id=new.device_id)) then
    perform public.norva_record_playback_health(new.user_id,new.playback_session_id,
      case when new.event_type='first_frame' then 'ok' else 'broken' end,
      coalesce(new.error_code,'') || ' ' || coalesce(new.error_message,''),new.device_id);
  end if;
  return new;
end;
$$;
revoke all on function public.norva_project_playback_health_event() from public, anon, authenticated;
create trigger playback_health_event after insert on public.cloud_playback_events
for each row execute function public.norva_project_playback_health_event();
