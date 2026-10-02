do $$
declare a text;b text;c text;d text;oe boolean;ne boolean;od boolean;nd boolean;visible boolean;
 expected integer;checks integer:=0;fenced boolean:=false;
begin
 -- All lifecycle state/visibility pairs, including hiding and restoration.
 foreach a in array array['active','purge_pending','purging','purged'] loop
 foreach b in array array['visible','hidden'] loop
 foreach c in array array['active','purge_pending','purging','purged'] loop
 foreach d in array array['visible','hidden'] loop
  perform public.test_reset_source(a,b,true,null);
  update public.cloud_source_lifecycle set lifecycle_state=c,catalog_visibility=d where source_id='10000000-0000-0000-0000-000000000001';
  expected:=case when (a='active' and b='visible') is distinct from (c='active' and d='visible') then 1 else 0 end;
  perform public.test_assert((select count(*)=expected from public.test_stale_events),'lifecycle membership transition '||a||'/'||b||' -> '||c||'/'||d);
  perform public.test_assert((select revision=0 from public.test_owner_snapshots where user_id='20000000-0000-0000-0000-000000000002'),'other owner untouched');
  checks:=checks+1;
 end loop;end loop;end loop;end loop;
 -- Enablement and soft-delete combinations with visible or hidden lifecycle.
 foreach visible in array array[true,false] loop
 foreach oe in array array[true,false] loop
 foreach ne in array array[true,false] loop
 foreach od in array array[true,false] loop
 foreach nd in array array[true,false] loop
  perform public.test_reset_source('active',case when visible then 'visible' else 'hidden' end,oe,case when od then '2026-09-01Z'::timestamptz else null end);
  update public.cloud_sources set enabled=ne,deleted_at=case when nd then '2026-10-01Z'::timestamptz else null end where id='10000000-0000-0000-0000-000000000001';
  expected:=case when visible and ((oe and not od) is distinct from (ne and not nd)) then 1 else 0 end;
  perform public.test_assert((select count(*)=expected from public.test_stale_events),'source membership transition');
  checks:=checks+1;
 end loop;end loop;end loop;end loop;end loop;
 perform public.test_reset_source('active','hidden',true,null);
 insert into public.cloud_source_transitions values('20000000-0000-0000-0000-000000000001','credential','committing');
 begin
  update public.cloud_source_lifecycle set lifecycle_state='purged' where source_id='10000000-0000-0000-0000-000000000001';
 exception when sqlstate 'PT409' then fenced:=true;end;
 perform public.test_assert(fenced,'cutover fence still rejects hidden housekeeping');
 update public.cloud_source_transitions set state='ready_to_switch';
 fenced:=false;
 begin
  update public.cloud_source_lifecycle set lifecycle_state='purged' where source_id='10000000-0000-0000-0000-000000000001';
 exception when sqlstate '40001' then fenced:=true;end;
 perform public.test_assert(fenced,'ready-to-switch fence remains routed through stale helper');
 delete from public.cloud_source_transitions;
 update public.cloud_source_provider_access set provider_access_status='expired_confirmed' where source_id='10000000-0000-0000-0000-000000000001';
 perform public.test_assert((select count(*)=1 from public.test_stale_events),'provider access invalidation preserved');
 truncate public.test_stale_events;
 insert into public.cloud_sources values('10000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001',false,null);
 delete from public.cloud_sources where id='10000000-0000-0000-0000-000000000003';
 perform public.test_assert((select count(*)=2 from public.test_stale_events),'insert/delete invalidation preserved');
 raise notice 'HIDDEN_SOURCE_TOPOLOGY_OK: % matrix cases plus isolation/cutover/access/insert/delete checks',checks;
end$$;
