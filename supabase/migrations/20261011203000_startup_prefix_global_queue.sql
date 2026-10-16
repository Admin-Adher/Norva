-- Inactive until the service-only Edge route and worker flag are enabled.
-- Coordinates only: no provider URLs, passwords, codec claims or media bytes.
create table public.startup_prefix_scan_cursors (
  source_id uuid primary key references public.cloud_sources(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot text not null,
  positions jsonb not null default '{}',
  turns bigint not null default 0,
  visited_at timestamptz not null default '-infinity',
  dispatched_at timestamptz not null default '-infinity',
  next_scan_at timestamptz not null default '-infinity'
);
create table public.startup_prefix_queue (
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check(item_type in ('movie','episode','series')),
  external_id text not null check(length(external_id) between 1 and 200),
  snapshot text not null,
  priority smallint not null check(priority between 0 and 2),
  next_at timestamptz not null default clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  last_result text check(last_result in ('prepared','deferred','unconfirmed')),
  primary key(source_id,item_type,external_id),
  check ((lease_id is null) = (lease_until is null))
);
create index startup_prefix_queue_due on public.startup_prefix_queue(next_at,priority,source_id);
alter table public.startup_prefix_scan_cursors enable row level security;
alter table public.startup_prefix_queue enable row level security;
revoke all on public.startup_prefix_scan_cursors,public.startup_prefix_queue from public,anon,authenticated;
grant select,insert,update,delete on public.startup_prefix_scan_cursors,public.startup_prefix_queue to service_role;

create function public.startup_prefix_source_snapshot(p_source uuid,p_user uuid)
returns text language sql stable security definer set search_path=public,pg_temp as $$
  select concat(l.config_revision,':',l.visibility_epoch,':',coalesce(u.visibility_epoch,1),':',coalesce(h.active_generation_id::text,'legacy'))
  from public.cloud_catalog_visible_sources s
  join public.cloud_source_lifecycle l on l.source_id=s.id and l.user_id=s.user_id
  left join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
  left join public.cloud_user_catalog_visibility_epochs u on u.user_id=s.user_id
  where s.id=p_source and s.user_id=p_user
$$;

-- One bounded page per claim. Rotation persists across restarts and workers.
-- Four current-year pages, one previous-year page, one older/unknown page.
create function public.claim_startup_prefix_queue()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.startup_prefix_scan_cursors%rowtype; q public.startup_prefix_queue%rowtype;
  v_snapshot text; bucket int; position jsonb; row_item record; count_page int:=0;
  v_year int:=extract(year from current_date); v_last jsonb; v_lease uuid;
begin
  perform public.norva_credential_require_service_role();
  -- Bound durable queue population as well as one response/page in memory.
  if pg_try_advisory_xact_lock(hashtextextended('norva-startup-prefix-page-v1',0))
    and (select count(*) from public.startup_prefix_queue)<=8128 then
    insert into public.startup_prefix_scan_cursors(source_id,user_id,snapshot)
      select s.id,s.user_id,public.startup_prefix_source_snapshot(s.id,s.user_id)
      from public.cloud_catalog_visible_sources s
      where public.startup_prefix_source_snapshot(s.id,s.user_id) is not null
      on conflict(source_id) do nothing;
    select * into c from public.startup_prefix_scan_cursors sc
      where (sc.next_scan_at<=clock_timestamp()
        or sc.snapshot is distinct from public.startup_prefix_source_snapshot(sc.source_id,sc.user_id))
        and public.startup_prefix_source_snapshot(sc.source_id,sc.user_id) is not null
      order by sc.visited_at,sc.source_id for update skip locked limit 1;
    if found then
      v_snapshot:=public.startup_prefix_source_snapshot(c.source_id,c.user_id);
      if c.snapshot<>v_snapshot then
        delete from public.startup_prefix_queue where source_id=c.source_id and lease_id is null;
        c.positions:='{}';c.turns:=0;c.snapshot:=v_snapshot;
      end if;
      bucket:=case when c.turns%6<4 then 0 when c.turns%6=4 then 1 else 2 end;
      position:=nullif(c.positions->bucket::text,'null'::jsonb);
      for row_item in
        select i.item_type,i.external_id,i.id from public.cloud_catalog_visible_media_items i
        cross join lateral (select case when i.item_type='movie' then coalesce(i.release_year,
          case when i.metadata->>'year' ~ '^\d{4}$' then (i.metadata->>'year')::int end)
          -- Series premiere years cannot certify an episode's airdate.
          else case when coalesce(i.metadata->>'episode_air_date',i.metadata->>'air_date')
            ~ '^(19|20)\d{2}-(0[1-9]|1[0-2])-([012][0-9]|3[01])$'
            then left(coalesce(i.metadata->>'episode_air_date',i.metadata->>'air_date'),4)::int end end as y) yr
        where i.source_id=c.source_id and i.user_id=c.user_id and i.available is true
          and (i.item_type in ('movie','episode') or (i.item_type='series' and nullif(i.parent_external_id,'') is not null))
          and length(i.external_id) between 1 and 200
          and (c.positions->bucket::text) is distinct from 'null'::jsonb
          and case bucket when 0 then yr.y=v_year when 1 then yr.y=v_year-1
            else yr.y is null or yr.y not in(v_year,v_year-1) end
          and (position is null or (i.item_type,i.external_id,i.id)>
            (position->>'type',position->>'external',(position->>'id')::uuid))
        order by i.item_type,i.external_id,i.id limit 64
      loop
        insert into public.startup_prefix_queue(source_id,user_id,item_type,external_id,snapshot,priority)
          values(c.source_id,c.user_id,row_item.item_type,row_item.external_id,v_snapshot,bucket)
          on conflict(source_id,item_type,external_id) do update
            set snapshot=excluded.snapshot,priority=excluded.priority,next_at=clock_timestamp()
            where startup_prefix_queue.snapshot<>excluded.snapshot and startup_prefix_queue.lease_id is null;
        count_page:=count_page+1;
        v_last:=jsonb_build_object('type',row_item.item_type,'external',row_item.external_id,'id',row_item.id);
      end loop;
      c.positions:=jsonb_set(c.positions,array[bucket::text],case when count_page<64 then 'null'::jsonb else v_last end,true);
      -- A completed sweep cools down, instead of repeatedly scanning an empty source.
      update public.startup_prefix_scan_cursors set snapshot=c.snapshot,
        turns=c.turns+1,visited_at=clock_timestamp(),
        next_scan_at=case when c.positions @> '{"0":null,"1":null,"2":null}'::jsonb
          then clock_timestamp()+interval '1 hour' else clock_timestamp() end,
        positions=case when c.positions @> '{"0":null,"1":null,"2":null}'::jsonb then '{}'::jsonb else c.positions end
        where source_id=c.source_id;
    end if;
  end if;
  -- Failed/removed generations cannot win a claim, even with an expired lease.
  delete from public.startup_prefix_queue j where (j.lease_until is null or j.lease_until<clock_timestamp())
    and j.snapshot is distinct from public.startup_prefix_source_snapshot(j.source_id,j.user_id);
  select j.* into q from public.startup_prefix_queue j
    join public.startup_prefix_scan_cursors sc on sc.source_id=j.source_id
    where j.next_at<=clock_timestamp() and (j.lease_until is null or j.lease_until<clock_timestamp())
      and not exists(select 1 from public.startup_prefix_queue running
        where running.user_id=j.user_id and running.lease_until>clock_timestamp())
      and j.snapshot=public.startup_prefix_source_snapshot(j.source_id,j.user_id)
      and exists(select 1 from public.cloud_catalog_visible_media_items i where i.user_id=j.user_id
        and i.source_id=j.source_id and i.item_type=j.item_type and i.external_id=j.external_id and i.available is true)
    order by (select max(owned.dispatched_at) from public.startup_prefix_scan_cursors owned where owned.user_id=j.user_id),
      sc.dispatched_at,j.priority,j.next_at,j.source_id,j.item_type,j.external_id
    for update of j skip locked limit 1;
  if not found then return null; end if;
  v_lease:=gen_random_uuid();
  update public.startup_prefix_queue set lease_id=v_lease,lease_until=clock_timestamp()+interval '5 minutes',
    attempts=attempts+1 where source_id=q.source_id and item_type=q.item_type and external_id=q.external_id;
  update public.startup_prefix_scan_cursors set dispatched_at=clock_timestamp() where source_id=q.source_id;
  return jsonb_build_object('leaseId',v_lease,'target',jsonb_build_object('userId',q.user_id,
    'sourceId',q.source_id,'itemType',q.item_type,'itemId',q.external_id));
end $$;

create function public.ack_startup_prefix_queue(p_lease_id uuid,p_prepared boolean,p_provider_drained boolean,p_retry_seconds integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.startup_prefix_queue%rowtype;
begin
  perform public.norva_credential_require_service_role();
  -- Uncertain transport/drain retains the five-minute exclusion. The existing
  -- provider admission still decides whether the next attempt is permissible.
  if p_provider_drained is distinct from true then return false; end if;
  select * into q from public.startup_prefix_queue where lease_id=p_lease_id
    and lease_until>clock_timestamp() for update;
  if not found then return false; end if;
  if q.snapshot is distinct from public.startup_prefix_source_snapshot(q.source_id,q.user_id) then
    delete from public.startup_prefix_queue where lease_id=p_lease_id;return false;
  end if;
  -- Completed work leaves the bounded work set. The persistent page cursors
  -- continue through the catalogue; R2 metadata owns the prepared-entry index.
  -- Three definite deferrals defer a file to the next catalogue sweep.
  if p_prepared is true or q.attempts>=3 then
    delete from public.startup_prefix_queue where lease_id=p_lease_id;return true;
  end if;
  update public.startup_prefix_queue set lease_id=null,lease_until=null,
    last_result=case when p_prepared is true then 'prepared' else 'deferred' end,
    next_at=clock_timestamp()+make_interval(secs=>greatest(30,least(604800,coalesce(p_retry_seconds,60))))
    where lease_id=p_lease_id;
  return true;
end $$;
revoke all on function public.startup_prefix_source_snapshot(uuid,uuid),public.claim_startup_prefix_queue(),
  public.ack_startup_prefix_queue(uuid,boolean,boolean,integer) from public,anon,authenticated;
grant execute on function public.startup_prefix_source_snapshot(uuid,uuid),public.claim_startup_prefix_queue(),
  public.ack_startup_prefix_queue(uuid,boolean,boolean,integer) to service_role;
