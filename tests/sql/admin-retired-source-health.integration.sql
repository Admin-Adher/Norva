\set ON_ERROR_STOP on
begin;
do $$ begin
  if current_database() not like 'norva_retired_alert_qa_%' then
    raise exception 'A disposable norva_retired_alert_qa_ database is required';
  end if;
end $$;

create table public.cloud_sources (
  id int primary key,user_id int,enabled boolean,deleted_at timestamptz,
  config_hint jsonb,sync_status text default 'syncing',sync_error text
);
create table public.cloud_media_items(source_id int,item_type text);
create table public.cloud_title_variants(source_id int);
create table public.admin_enrichment_accounts(user_id int);

-- Keep the four production query contexts, including independent driver/error
-- reasons for retaining a source row. Other dashboard/metric values are sentinels.
create function public.refresh_admin_dashboard() returns jsonb
language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  with mc as (select source_id,count(*) filter(where item_type in ('movie','series')) n_ms from cloud_media_items group by source_id),
       vc as (select source_id,count(*) n from cloud_title_variants group by source_id),
       src as (
    select s.id,
           (s.deleted_at is null and coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete
    from cloud_sources s left join mc on mc.source_id=s.id left join vc on vc.source_id=s.id
    where s.deleted_at is null
      and (
        s.user_id in (select user_id from public.admin_enrichment_accounts)
        or s.sync_status = 'sync_error' or s.sync_error is not null
        or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
            and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))
      )
  )
  select jsonb_build_object(
      'sources_incomplete',(select count(*) from cloud_sources s
          left join mc on mc.source_id=s.id left join vc on vc.source_id=s.id
          where s.deleted_at is null and coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),
      'sources',(select coalesce(jsonb_agg(to_jsonb(src) order by id),'[]'::jsonb) from src),
      'unrelated',37
  ) into result;
  return result;
end $$;

create function public.snapshot_admin_metrics() returns jsonb
language plpgsql security definer set search_path=public as $$
declare t timestamptz:=now(); result jsonb;
begin
  select jsonb_object_agg(metric,value) into result from (values
    (t,'sources_incomplete', (select count(*) from cloud_sources s
                                left join (select source_id, count(*) n from cloud_media_items where item_type in ('movie','series') group by 1) mc on mc.source_id=s.id
                                left join (select source_id, count(*) n from cloud_title_variants group by 1) vc on vc.source_id=s.id
                                where s.deleted_at is null and coalesce(mc.n,0)>0 and coalesce(vc.n,0)=0)),
    (t,'unrelated',93)
  ) values_to_record(at,metric,value);
  return result;
end $$;

insert into public.cloud_sources(id,user_id,enabled,config_hint)
select i,i,true,'{}'::jsonb from generate_series(1,16) i;
-- 1/16: explicit retired disabled sources, with 16 also being an admin driver.
update public.cloud_sources set enabled=false,config_hint='{"managedBy":"norva-cloud","selectionGeneralFeedRetirement":{"at":"2026-09-06T07:40:00Z"}}' where id in (1,16);
insert into public.admin_enrichment_accounts values(16);
-- The marker alone is not sufficient: it must be server-managed and disabled.
update public.cloud_sources set enabled=false,config_hint='{"selectionGeneralFeedRetirement":{"at":"2026-09-06T07:40:00Z"}}' where id=2;
update public.cloud_sources set config_hint='{"managedBy":"norva-cloud","selectionGeneralFeedRetirement":{"at":"2026-09-06T07:40:00Z"}}' where id=3;
update public.cloud_sources set enabled=false where id=4;
update public.cloud_sources set enabled=null where id=5;
update public.cloud_sources set config_hint=null where id=6;
update public.cloud_sources set enabled=false,config_hint='{"managedBy":"norva-cloud","selectionGeneralFeedRetirement":{"at":"  "}}' where id=7;
update public.cloud_sources set enabled=false,config_hint='{"managedBy":"norva-cloud","selectionGeneralFeedRetirement":{"at":123}}' where id=8;
update public.cloud_sources set deleted_at=now() where id=9;
update public.cloud_sources set enabled=false,config_hint='{"managedBy":"norva-cloud","selectionGeneralFeedRetirement":{}}' where id=13;
update public.cloud_sources set enabled=false,config_hint='{"managedBy":"other","selectionGeneralFeedRetirement":{"at":"2026-09-06T07:40:00Z"}}' where id=14;
-- 10 has playable variants; 11 is live-only; 12 has not discovered any VOD.
insert into public.cloud_media_items select i,'movie' from generate_series(1,16) i where i not in (11,12);
insert into public.cloud_media_items values(11,'live');
insert into public.cloud_title_variants values(10);

create temporary table original_function_permissions as
select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid in
  ('public.refresh_admin_dashboard()'::regprocedure,'public.snapshot_admin_metrics()'::regprocedure);
do $$ begin
  if (public.refresh_admin_dashboard()->>'sources_incomplete')::int <> 12 then
    raise exception 'Fixture must reproduce retired-source false positives';
  end if;
end $$;

\ir ../../supabase/migrations/20260909131402_admin_ignore_retired_selection_sources.sql
\ir ../../supabase/migrations/20260909131402_admin_ignore_retired_selection_sources.sql

do $$ declare dashboard jsonb; metrics jsonb; actual int[]; begin
  dashboard:=public.refresh_admin_dashboard();
  metrics:=public.snapshot_admin_metrics();
  if dashboard->>'sources_incomplete'<>'10' or metrics->>'sources_incomplete'<>'10' then
    raise exception 'Dashboard and metric counters must exclude only retired disabled sources';
  end if;
  select array_agg((row->>'id')::int order by (row->>'id')::int) into actual
    from jsonb_array_elements(dashboard->'sources') row where (row->>'incomplete')::boolean;
  if actual<>array[2,3,4,5,6,7,8,13,14,15] then
    raise exception 'An actionable source was hidden or an obsolete source stayed incomplete';
  end if;
  if exists(select from jsonb_array_elements(dashboard->'sources') row where row->>'id'='1') then
    raise exception 'Retired source retained an obsolete dashboard issue row';
  end if;
  if not exists(select from jsonb_array_elements(dashboard->'sources') row where row->>'id'='16' and row->>'incomplete'='false') then
    raise exception 'Admin driver must remain inspectable without an incomplete badge';
  end if;
  if dashboard->>'unrelated'<>'37' or metrics->>'unrelated'<>'93' then
    raise exception 'Unrelated dashboard/metric values changed';
  end if;
  if exists(select from original_function_permissions before join pg_proc after on after.oid=before.oid
    where (before.proowner,before.proacl,before.prosecdef,before.proconfig) is distinct from
          (after.proowner,after.proacl,after.prosecdef,after.proconfig)) then
    raise exception 'Function owner, grants or security settings changed';
  end if;
  if (select count(*) from cloud_sources)<>16 or (select count(*) from cloud_media_items)<>15
    or (select count(*) from cloud_title_variants)<>1 then
    raise exception 'Monitoring correction modified catalogue data';
  end if;
end $$;

-- Reactivation is authoritative, even when the historical retirement marker stays.
update public.cloud_sources set enabled=true where id=1;
do $$ begin
  if public.refresh_admin_dashboard()->>'sources_incomplete'<>'11'
    or public.snapshot_admin_metrics()->>'sources_incomplete'<>'11' then
    raise exception 'A reactivated source must immediately re-enter monitoring';
  end if;
end $$;

select 'ADMIN_RETIRED_SOURCE_HEALTH_INTEGRATION_OK';
rollback;
