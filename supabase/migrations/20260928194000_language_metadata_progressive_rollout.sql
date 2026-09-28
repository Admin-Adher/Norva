begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Rollout membership is an owner bucket, not an entitlement or provider lease.
-- Installation is inert. Internal and ordinary owners use the same buckets.
create table public.catalog_language_metadata_rollout (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0 check(revision>=0),
 basis_points integer not null default 0 check(basis_points in (0,100,500,2000,5000,10000)),
 updated_at timestamptz not null default clock_timestamp()
);
insert into public.catalog_language_metadata_rollout(singleton) values(true);
create table public.catalog_language_metadata_rollout_events (
 revision bigint primary key,
 previous_basis_points integer not null,
 basis_points integer not null,
 note text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.catalog_language_metadata_rollout enable row level security;
alter table public.catalog_language_metadata_rollout force row level security;
alter table public.catalog_language_metadata_rollout_events enable row level security;
alter table public.catalog_language_metadata_rollout_events force row level security;
revoke all on public.catalog_language_metadata_rollout,public.catalog_language_metadata_rollout_events
 from public,anon,authenticated,service_role;
grant select on public.catalog_language_metadata_rollout,public.catalog_language_metadata_rollout_events to service_role;

create function public.set_catalog_language_metadata_rollout(
 p_expected_revision bigint,p_basis_points integer,p_note text
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare current_row public.catalog_language_metadata_rollout%rowtype; next_points integer; previous_points integer;
begin
 perform public.norva_credential_require_service_role();
 if p_expected_revision is null or p_basis_points is null
   or p_basis_points not in (0,100,500,2000,5000,10000)
   or coalesce(length(btrim(p_note)),0) not between 16 and 500 then
   raise exception 'Invalid metadata rollout request' using errcode='22023';
 end if;
 select * into strict current_row from public.catalog_language_metadata_rollout where singleton for update;
 if current_row.revision<>p_expected_revision then
   raise exception 'Metadata rollout revision changed' using errcode='PT409';
 end if;
 next_points:=case current_row.basis_points when 0 then 100 when 100 then 500
   when 500 then 2000 when 2000 then 5000 when 5000 then 10000 else 10000 end;
 -- Any rollback is allowed; forward changes cannot skip an observation stage.
 if p_basis_points>current_row.basis_points and p_basis_points<>next_points then
   raise exception 'Metadata rollout stage skipped' using errcode='22023';
 end if;
 if p_basis_points=current_row.basis_points then
   return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',false);
 end if;
 previous_points:=current_row.basis_points;
 update public.catalog_language_metadata_rollout set revision=revision+1,
   basis_points=p_basis_points,updated_at=clock_timestamp() where singleton
   returning * into current_row;
 insert into public.catalog_language_metadata_rollout_events(revision,previous_basis_points,basis_points,note)
 values(current_row.revision,previous_points,p_basis_points,btrim(p_note));
 return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',true);
end $f$;

-- A cohort selects a path; it never grants source access or raises capacity.
create function public.catalog_language_metadata_enabled_for_source(p_user uuid,p_source uuid)
returns boolean language sql stable security definer set search_path='' as $f$
 select exists (
  select 1 from auth.users u join public.cloud_sources s on s.user_id=u.id
  cross join public.catalog_language_metadata_rollout r
  where u.id=p_user and s.id=p_source and u.deleted_at is null
   and (u.banned_until is null or u.banned_until<=now())
   and s.enabled and s.deleted_at is null and s.sync_status='ready' and r.singleton
   and (public.catalog_language_metadata_lane_enabled() or
    (('x'||substr(md5('norva-language-metadata-v1:'||u.id::text),1,8))::bit(32)::bigint % 10000)<r.basis_points)
 )
$f$;
create function public.catalog_language_metadata_available_for_source(p_user uuid,p_source uuid)
returns boolean language sql volatile security definer set search_path='' as $f$
 select public.catalog_language_metadata_enabled_for_source(p_user,p_source) and
  coalesce((select c.expires_at>clock_timestamp() and c.max_workers>
   (select count(*) from public.catalog_vod_language_intake q
    where q.state='leased' and q.lease_until>clock_timestamp())
   from public.catalog_language_metadata_capacity c where c.singleton),false)
$f$;

-- Keep installed visibility, entitlement, generation, quarantine, cursor and
-- admission-lock logic verbatim. Drift aborts the migration transaction.
do $patch$
declare d text; needle text;
begin
 d:=pg_get_functiondef('public.claim_catalog_vod_language_file(uuid,uuid)'::regprocedure);
 foreach needle in array array['public.catalog_language_metadata_lane_enabled()',
  'public.catalog_language_metadata_available()'] loop
  if (length(d)-length(replace(d,needle,'')))/length(needle)<>1 then
   raise exception 'Metadata source admission gate drifted: %',needle;
  end if;
 end loop;
 d:=replace(d,'public.catalog_language_metadata_lane_enabled()',
  'public.catalog_language_metadata_enabled_for_source(p_user,p_source)');
 d:=replace(d,'public.catalog_language_metadata_available()',
  'public.catalog_language_metadata_available_for_source(p_user,p_source)');
 execute d;
end $patch$;
revoke all on function public.set_catalog_language_metadata_rollout(bigint,integer,text),
 public.catalog_language_metadata_enabled_for_source(uuid,uuid),
 public.catalog_language_metadata_available_for_source(uuid,uuid) from public,anon,authenticated;
grant execute on function public.set_catalog_language_metadata_rollout(bigint,integer,text),
 public.catalog_language_metadata_enabled_for_source(uuid,uuid),
 public.catalog_language_metadata_available_for_source(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
