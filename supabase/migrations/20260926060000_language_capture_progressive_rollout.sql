begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Rollout membership is an owner bucket, not an entitlement or provider lease.
-- Installation is inert. Internal and ordinary owners use the same buckets.
create table public.catalog_language_capture_rollout (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0 check(revision>=0),
 basis_points integer not null default 0 check(basis_points in (0,100,500,2000,5000,10000)),
 updated_at timestamptz not null default clock_timestamp()
);
insert into public.catalog_language_capture_rollout(singleton) values(true);
create table public.catalog_language_capture_rollout_events (
 revision bigint primary key,
 previous_basis_points integer not null,
 basis_points integer not null,
 note text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.catalog_language_capture_rollout enable row level security;
alter table public.catalog_language_capture_rollout force row level security;
alter table public.catalog_language_capture_rollout_events enable row level security;
alter table public.catalog_language_capture_rollout_events force row level security;
revoke all on public.catalog_language_capture_rollout,public.catalog_language_capture_rollout_events
 from public,anon,authenticated,service_role;
grant select on public.catalog_language_capture_rollout,public.catalog_language_capture_rollout_events to service_role;

create function public.set_catalog_language_capture_rollout(
 p_expected_revision bigint,p_basis_points integer,p_note text
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare current_row public.catalog_language_capture_rollout%rowtype; next_points integer; previous_points integer;
begin
 perform public.norva_credential_require_service_role();
 if p_expected_revision is null or p_basis_points is null
   or p_basis_points not in (0,100,500,2000,5000,10000)
   or coalesce(length(btrim(p_note)),0) not between 16 and 500 then
   raise exception 'Invalid capture rollout request' using errcode='22023';
 end if;
 select * into strict current_row from public.catalog_language_capture_rollout where singleton for update;
 if current_row.revision<>p_expected_revision then
   raise exception 'Capture rollout revision changed' using errcode='PT409';
 end if;
 next_points:=case current_row.basis_points when 0 then 100 when 100 then 500
   when 500 then 2000 when 2000 then 5000 when 5000 then 10000 else 10000 end;
 -- Any rollback is allowed; forward changes cannot skip an observation stage.
 if p_basis_points>current_row.basis_points and p_basis_points<>next_points then
   raise exception 'Capture rollout stage skipped' using errcode='22023';
 end if;
 if p_basis_points=current_row.basis_points then
   return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',false);
 end if;
 previous_points:=current_row.basis_points;
 update public.catalog_language_capture_rollout set revision=revision+1,
   basis_points=p_basis_points,updated_at=clock_timestamp() where singleton
   returning * into current_row;
 insert into public.catalog_language_capture_rollout_events(revision,previous_basis_points,basis_points,note)
 values(current_row.revision,previous_points,p_basis_points,btrim(p_note));
 return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',true);
end $f$;

create function public.catalog_language_capture_rollout_enabled_for_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path='' as $f$
 select exists (
   select 1 from public.catalog_language_capture_rollout r
   join public.catalog_file_audio_validation_jobs j on j.id=p_job_id
   join auth.users u on u.id=j.requested_by and u.deleted_at is null
     and (u.banned_until is null or u.banned_until<=now())
   join public.cloud_sources s on s.id=j.source_id and s.user_id=j.requested_by
     and s.enabled and s.deleted_at is null and s.sync_status='ready'
   where r.singleton and r.basis_points>0
     and j.state in ('queued','running','retry_wait','finalizing') and j.quarantined_at is null
     and (('x'||substr(md5('norva-language-capture-v1:'||j.requested_by::text),1,8))::bit(32)::bigint % 10000)<r.basis_points
 )
$f$;

-- Preserve the existing global switch and the expiring internal pilot, changing
-- only path selection. Worker ownership/profile/drain/foreground guards remain.
do $patch$
declare definition text; needle text:='select public.catalog_language_capture_pipeline_enabled() or exists (';
begin
 definition:=pg_get_functiondef('public.catalog_language_capture_pipeline_enabled_for_job(uuid)'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
   raise exception 'Capture rollout gate drifted';
 end if;
 execute replace(definition,needle,'select public.catalog_language_capture_pipeline_enabled() or public.catalog_language_capture_rollout_enabled_for_job(p_job_id) or exists (');
end $patch$;
revoke all on function public.set_catalog_language_capture_rollout(bigint,integer,text),
 public.catalog_language_capture_rollout_enabled_for_job(uuid) from public,anon,authenticated;
grant execute on function public.set_catalog_language_capture_rollout(bigint,integer,text),
 public.catalog_language_capture_rollout_enabled_for_job(uuid) to service_role;
notify pgrst,'reload schema';
commit;
