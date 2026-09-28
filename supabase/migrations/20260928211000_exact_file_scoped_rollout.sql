begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Rollout membership is an owner bucket, not an entitlement or provider lease.
-- Installation is inert. Internal and ordinary owners use the same buckets.
create table public.catalog_language_exact_file_rollout (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0 check(revision>=0),
 basis_points integer not null default 0 check(basis_points in (0,100,500,2000,5000,10000)),
 updated_at timestamptz not null default clock_timestamp()
);
insert into public.catalog_language_exact_file_rollout(singleton) values(true);
create table public.catalog_language_exact_file_rollout_events (
 revision bigint primary key,
 previous_basis_points integer not null,
 basis_points integer not null,
 note text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.catalog_language_exact_file_rollout enable row level security;
alter table public.catalog_language_exact_file_rollout force row level security;
alter table public.catalog_language_exact_file_rollout_events enable row level security;
alter table public.catalog_language_exact_file_rollout_events force row level security;
revoke all on public.catalog_language_exact_file_rollout,public.catalog_language_exact_file_rollout_events
 from public,anon,authenticated,service_role;
grant select on public.catalog_language_exact_file_rollout,public.catalog_language_exact_file_rollout_events to service_role;

create function public.set_catalog_language_exact_file_rollout(
 p_expected_revision bigint,p_basis_points integer,p_note text
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare current_row public.catalog_language_exact_file_rollout%rowtype; next_points integer; previous_points integer;
begin
 perform public.norva_credential_require_service_role();
 if p_expected_revision is null or p_basis_points is null
   or p_basis_points not in (0,100,500,2000,5000,10000)
   or coalesce(length(btrim(p_note)),0) not between 16 and 500 then
   raise exception 'Invalid exact-file rollout request' using errcode='22023';
 end if;
 select * into strict current_row from public.catalog_language_exact_file_rollout where singleton for update;
 if current_row.revision<>p_expected_revision then
   raise exception 'Exact-file rollout revision changed' using errcode='PT409';
 end if;
 next_points:=case current_row.basis_points when 0 then 100 when 100 then 500
   when 500 then 2000 when 2000 then 5000 when 5000 then 10000 else 10000 end;
 -- Any rollback is allowed; forward changes cannot skip an observation stage.
 if p_basis_points>current_row.basis_points and p_basis_points<>next_points then
   raise exception 'Exact-file rollout stage skipped' using errcode='22023';
 end if;
 if p_basis_points=current_row.basis_points then
   return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',false);
 end if;
 previous_points:=current_row.basis_points;
 update public.catalog_language_exact_file_rollout set revision=revision+1,
   basis_points=p_basis_points,updated_at=clock_timestamp() where singleton
   returning * into current_row;
 insert into public.catalog_language_exact_file_rollout_events(revision,previous_basis_points,basis_points,note)
 values(current_row.revision,previous_points,p_basis_points,btrim(p_note));
 return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',true);
end $f$;


-- Selection is independent from capture activation: metadata needs no capture.
-- The worker separately requires its existing job-aware capture admission.
create function public.catalog_language_exact_file_enabled_for_source(p_user uuid,p_source uuid)
returns boolean language sql stable security definer set search_path='' as $f$
 select public.catalog_language_metadata_enabled_for_source(p_user,p_source)
  and public.norva_source_catalog_visible(p_source,p_user) and exists(
  select 1 from public.catalog_language_exact_file_rollout r where r.singleton and
   (public.catalog_language_exact_file_admission_enabled() or
    (('x'||substr(md5('norva-language-metadata-v1:'||p_user::text),1,8))::bit(32)::bigint % 10000)<r.basis_points)
 )
$f$;

-- Reuse the installed mono-account/file locking and viewer checks verbatim.
-- The old RPC stays gated as before for older workers during a rolling deploy.
do $patch$
declare d text; old text;
begin
 d:=pg_get_functiondef('public.claim_provider_exact_file_probe(text,text,text,text,text,integer)'::regprocedure);
 old:='CREATE OR REPLACE FUNCTION public.claim_provider_exact_file_probe(';
 if position(old in d)<>1 then raise exception 'Exact-file claim signature drifted'; end if;
 d:=replace(d,old,'CREATE OR REPLACE FUNCTION public.claim_provider_exact_file_probe_for_source(p_user uuid, p_source uuid, ');
 old:='not public.catalog_language_exact_file_admission_enabled()';
 if (length(d)-length(replace(d,old,'')))/length(old)<>1 then
  raise exception 'Exact-file claim gate drifted';
 end if;
 d:=replace(d,old,$guard$not public.catalog_language_exact_file_enabled_for_source(p_user,p_source)
    or not (exists (
      select 1 from public.cloud_catalog_visible_title_variants v
      left join public.catalog_source_provider_identities i on i.source_id=v.source_id and i.user_id=v.user_id
      where v.user_id=p_user and v.source_id=p_source and v.item_type=p_item_type
       and v.external_id=btrim(p_external_id)
       and coalesce(i.identity_id::text,'source:'||v.source_id::text)=btrim(p_identity_key)
       and (i.identity_id is null or i.verified_at is not null)
    ) or exists (
      select 1 from public.catalog_file_audio_validation_jobs j
      where j.requested_by=p_user and j.source_id=p_source
       and j.identity_key=btrim(p_identity_key) and j.item_type=p_item_type
       and j.external_id=btrim(p_external_id) and j.state='running'
       and j.lease_expires_at>clock_timestamp() and j.quarantined_at is null
    ))$guard$);
 execute d;
end $patch$;
revoke all on function public.set_catalog_language_exact_file_rollout(bigint,integer,text),
 public.catalog_language_exact_file_enabled_for_source(uuid,uuid),
 public.claim_provider_exact_file_probe_for_source(uuid,uuid,text,text,text,text,text,integer)
 from public,anon,authenticated;
grant execute on function public.set_catalog_language_exact_file_rollout(bigint,integer,text),
 public.catalog_language_exact_file_enabled_for_source(uuid,uuid),
 public.claim_provider_exact_file_probe_for_source(uuid,uuid,text,text,text,text,text,integer) to service_role;
notify pgrst,'reload schema';
commit;
