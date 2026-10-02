-- Synthetic trigger fixture. No production rows or credentials.
create table public.cloud_sources(id uuid primary key,user_id uuid,enabled boolean,deleted_at timestamptz);
create table public.cloud_source_lifecycle(source_id uuid primary key,user_id uuid,lifecycle_state text,catalog_visibility text);
create table public.cloud_source_provider_access(source_id uuid primary key,user_id uuid,provider_access_status text,provider_access_hidden_at timestamptz,provider_access_restored_at timestamptz);
create table public.cloud_source_transitions(user_id uuid,transition_kind text,state text);
create table public.test_stale_events(user_id uuid);
create table public.test_owner_snapshots(user_id uuid primary key,state text,revision bigint default 0);
create function public.norva_mark_catalog_background_owner_stale(p_user_id uuid) returns void language plpgsql as $$
begin
 if exists (select 1 from public.cloud_source_transitions where user_id=p_user_id and transition_kind='credential' and state='ready_to_switch') then
  raise exception 'catalog topology is fenced before cutover' using errcode='40001';
 end if;
 insert into public.test_stale_events values(p_user_id);
 update public.test_owner_snapshots set state='stale',revision=revision+1 where user_id=p_user_id;
end$$;
create function public.test_assert(ok boolean, description text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception '%',description; end if; end$$;
insert into public.cloud_sources values
 ('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',true,null),
 ('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002',true,null);
insert into public.cloud_source_lifecycle select id,user_id,'purge_pending','hidden' from public.cloud_sources;
insert into public.cloud_source_provider_access select id,user_id,'active',null,null from public.cloud_sources;
insert into public.test_owner_snapshots select user_id,'active',0 from public.cloud_sources;

-- Match production WHEN predicates, so updates that cannot reach the guard
-- are not mistaken for a successful optimization of that guard.
create trigger source_topology_u before update of enabled,deleted_at on public.cloud_sources
for each row when (old.enabled is distinct from new.enabled or old.deleted_at is distinct from new.deleted_at)
execute function public.norva_catalog_background_owner_topology_guard();
create trigger lifecycle_topology_u before update of lifecycle_state,catalog_visibility on public.cloud_source_lifecycle
for each row when (old.lifecycle_state is distinct from new.lifecycle_state or old.catalog_visibility is distinct from new.catalog_visibility)
execute function public.norva_catalog_background_owner_topology_guard();
create trigger access_topology_u before update of provider_access_status,provider_access_hidden_at,provider_access_restored_at on public.cloud_source_provider_access
for each row when (old.provider_access_status is distinct from new.provider_access_status or old.provider_access_hidden_at is distinct from new.provider_access_hidden_at or old.provider_access_restored_at is distinct from new.provider_access_restored_at)
execute function public.norva_catalog_background_owner_topology_guard();
create trigger source_topology_i before insert on public.cloud_sources for each row execute function public.norva_catalog_background_owner_topology_guard();
create trigger source_topology_d before delete on public.cloud_sources for each row execute function public.norva_catalog_background_owner_topology_guard();

create function public.test_reset_source(p_state text,p_visibility text,p_enabled boolean,p_deleted timestamptz) returns void language plpgsql as $$
begin
 alter table public.cloud_source_lifecycle disable trigger lifecycle_topology_u;
 alter table public.cloud_sources disable trigger source_topology_u;
 update public.cloud_source_lifecycle set lifecycle_state=p_state,catalog_visibility=p_visibility where source_id='10000000-0000-0000-0000-000000000001';
 update public.cloud_sources set enabled=p_enabled,deleted_at=p_deleted where id='10000000-0000-0000-0000-000000000001';
 alter table public.cloud_source_lifecycle enable trigger lifecycle_topology_u;
 alter table public.cloud_sources enable trigger source_topology_u;
 truncate public.test_stale_events;
 update public.test_owner_snapshots set state='active',revision=0;
end$$;
