begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Rollout membership is an owner bucket, not an entitlement or provider lease.
-- Installation is inert. Internal and ordinary owners use the same buckets.
create table public.catalog_owned_language_metadata_rollout (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 0 check(revision>=0),
 basis_points integer not null default 0 check(basis_points in (0,100,500,2000,5000,10000)),
 updated_at timestamptz not null default clock_timestamp()
);
insert into public.catalog_owned_language_metadata_rollout(singleton) values(true);
create table public.catalog_owned_language_metadata_rollout_events (
 revision bigint primary key,
 previous_basis_points integer not null,
 basis_points integer not null,
 note text not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.catalog_owned_language_metadata_rollout enable row level security;
alter table public.catalog_owned_language_metadata_rollout force row level security;
alter table public.catalog_owned_language_metadata_rollout_events enable row level security;
alter table public.catalog_owned_language_metadata_rollout_events force row level security;
revoke all on public.catalog_owned_language_metadata_rollout,public.catalog_owned_language_metadata_rollout_events
 from public,anon,authenticated,service_role;
grant select on public.catalog_owned_language_metadata_rollout,public.catalog_owned_language_metadata_rollout_events to service_role;

create function public.set_catalog_owned_language_metadata_rollout(
 p_expected_revision bigint,p_basis_points integer,p_note text
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare current_row public.catalog_owned_language_metadata_rollout%rowtype; next_points integer; previous_points integer;
begin
 perform public.norva_credential_require_service_role();
 if p_expected_revision is null or p_basis_points is null
   or p_basis_points not in (0,100,500,2000,5000,10000)
   or coalesce(length(btrim(p_note)),0) not between 16 and 500 then
   raise exception 'Invalid provider-metadata rollout request' using errcode='22023';
 end if;
 select * into strict current_row from public.catalog_owned_language_metadata_rollout where singleton for update;
 if current_row.revision<>p_expected_revision then
   raise exception 'Provider-metadata rollout revision changed' using errcode='PT409';
 end if;
 next_points:=case current_row.basis_points when 0 then 100 when 100 then 500
   when 500 then 2000 when 2000 then 5000 when 5000 then 10000 else 10000 end;
 -- Any rollback is allowed; forward changes cannot skip an observation stage.
 if p_basis_points>current_row.basis_points and p_basis_points<>next_points then
   raise exception 'Provider-metadata rollout stage skipped' using errcode='22023';
 end if;
 if p_basis_points=current_row.basis_points then
   return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',false);
 end if;
 previous_points:=current_row.basis_points;
 update public.catalog_owned_language_metadata_rollout set revision=revision+1,
   basis_points=p_basis_points,updated_at=clock_timestamp() where singleton
   returning * into current_row;
 insert into public.catalog_owned_language_metadata_rollout_events(revision,previous_basis_points,basis_points,note)
 values(current_row.revision,previous_points,p_basis_points,btrim(p_note));
 return jsonb_build_object('revision',current_row.revision,'basisPoints',current_row.basis_points,'changed',true);
end $f$;


create function public.catalog_owned_language_metadata_enabled_for_source(p_user uuid,p_source uuid)
returns boolean language sql stable security definer set search_path='' as $f$
 select p_user is not null and p_source is not null
 and public.norva_source_catalog_visible(p_source,p_user)
 and (exists(select 1 from public.admin_feature_flags where key='owned_provider_language_metadata_enabled' and enabled)
 or exists(select 1 from public.catalog_owned_language_metadata_rollout r where r.singleton
 and (('x'||substr(md5('norva-language-metadata-v1:'||p_user::text),1,8))::bit(32)::bigint %10000)<r.basis_points))
$f$;
revoke all on function public.catalog_owned_language_metadata_enabled_for_source(uuid,uuid),
 public.set_catalog_owned_language_metadata_rollout(bigint,integer,text) from public,anon,authenticated;
grant execute on function public.catalog_owned_language_metadata_enabled_for_source(uuid,uuid),
 public.set_catalog_owned_language_metadata_rollout(bigint,integer,text) to service_role;

set local search_path='';
do $patch$
declare d text;pattern text;replacement text;
begin
 pattern:='EXISTS \( SELECT 1\s+FROM public.admin_feature_flags\s+WHERE admin_feature_flags.key = ''owned_provider_language_metadata_enabled''::text AND admin_feature_flags.enabled\)';
 replacement:='public.catalog_owned_language_metadata_enabled_for_source(v.user_id,v.source_id)';
 d:=rtrim(pg_get_viewdef('public.cloud_catalog_owned_audio_declarations'::regclass,true),E';\n ');
 if (select count(*) from regexp_matches(d,pattern,'g'))<>1 then raise exception 'Declaration view gate drift'; end if;
 execute 'create or replace view public.cloud_catalog_owned_audio_declarations with(security_invoker=true) as '||regexp_replace(d,pattern,replacement);
 d:=pg_get_functiondef('public.cloud_catalog_owned_audio_declarations_scoped(uuid,uuid,text)'::regprocedure);
 if (select count(*) from regexp_matches(d,pattern,'g'))<>1 then raise exception 'Scoped declaration gate drift'; end if;
 -- Evaluate rollout once per visible source, not once per episode declaration.
 replacement:='v.source_id IN (SELECT gate_source.id FROM public.cloud_catalog_visible_sources gate_source
   WHERE gate_source.user_id=p_user_id AND (p_source_id IS NULL OR gate_source.id=p_source_id)
   AND public.catalog_owned_language_metadata_enabled_for_source(gate_source.user_id,gate_source.id))';
 execute regexp_replace(d,pattern,replacement);
 d:=pg_get_functiondef('public.catalog_series_inventory_candidates(uuid,uuid,integer)'::regprocedure);
 pattern:='exists(select 1 from public.admin_feature_flags where key=''owned_provider_language_metadata_enabled'' and enabled)';
 if (length(d)-length(replace(d,pattern,'')))/length(pattern)<>1 then raise exception 'Series refresh gate drift'; end if;
 execute replace(d,pattern,'public.catalog_owned_language_metadata_enabled_for_source(p_user,p_source)');
end $patch$;
notify pgrst,'reload schema';
commit;
