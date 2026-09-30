begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';

-- Transport rotation keeps the active generation and owner snapshot intact.
-- Only exact, complete inventory manifests qualify; this is not a sample or
-- a user-facing "same provider" checkbox bypassing catalogue identity.
create table public.cloud_source_transport_checks (
  transition_id uuid primary key references public.cloud_source_transitions(id) on delete cascade,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  head_revision bigint not null,
  generation_revision bigint not null,
  config_revision bigint not null,
  baseline_checksum text not null check (baseline_checksum ~ '^[a-f0-9]{64}$'),
  baseline_count bigint not null check (baseline_count >= 0),
  candidate_ciphertext_hash text not null check (candidate_ciphertext_hash ~ '^[a-f0-9]{64}$'),
  parts jsonb not null default '{}'::jsonb check (jsonb_typeof(parts) = 'object' and octet_length(parts::text) <= 8192),
  state text not null default 'checking' check (state in ('checking','not_matching','ready','applied','completed','rolled_back')),
  checked_at timestamptz not null default now(),
  applied_at timestamptz,
  completed_at timestamptz,
  foreign key (user_id,transition_id) references public.cloud_source_transitions(user_id,id) on delete cascade,
  foreign key (source_id,generation_id) references public.cloud_source_catalog_generations(source_id,id) on delete cascade
);
alter table public.cloud_source_transport_checks enable row level security;
revoke all on public.cloud_source_transport_checks from public,anon,authenticated,service_role;

create or replace function public.norva_transport_catalog_manifest(p_generation_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $function$
  with hashes as (
    select extensions.digest(jsonb_build_array('media',item.item_type,item.external_id,
      item.parent_external_id,item.title)::text,'sha256') as h
    from public.cloud_media_items item where item.generation_id=p_generation_id
  ), lanes as (
    select ('x'||substr(encode(h,'hex'),1,16))::bit(64)::bigint as a,
      ('x'||substr(encode(h,'hex'),17,16))::bit(64)::bigint as b,
      ('x'||substr(encode(h,'hex'),33,16))::bit(64)::bigint as c,
      ('x'||substr(encode(h,'hex'),49,16))::bit(64)::bigint as d from hashes
  ), totals as (
    select count(*) as n,coalesce(sum(a::numeric),0)::text as sa,coalesce(bit_xor(a),0)::text as xa,
      coalesce(sum(b::numeric),0)::text as sb,coalesce(bit_xor(b),0)::text as xb,
      coalesce(sum(c::numeric),0)::text as sc,coalesce(bit_xor(c),0)::text as xc,
      coalesce(sum(d::numeric),0)::text as sd,coalesce(bit_xor(d),0)::text as xd from lanes
  ) select jsonb_build_object('count',n,'checksum',encode(extensions.digest(jsonb_build_array(
    'norva-catalog-content-manifest-v2',n,sa,xa,sb,xb,sc,xc,sd,xd)::text,'sha256'),'hex')) from totals
$function$;
revoke all on function public.norva_transport_catalog_manifest(uuid) from public,anon,authenticated,service_role;

create or replace function public.norva_get_credential_transport_check(p_transition_id uuid,p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  select jsonb_build_object('state',upper(checks.state),'generationId',checks.generation_id,
    'headRevision',checks.head_revision,'generationRevision',checks.generation_revision,
    'sourceRevision',checks.config_revision,'parts',checks.parts,
    'baselineChecksum',checks.baseline_checksum,'baselineCount',checks.baseline_count)
    into v_result from public.cloud_source_transport_checks checks
    where checks.transition_id=p_transition_id and checks.user_id=p_user_id;
  return coalesce(v_result,jsonb_build_object('state','NONE'));
end
$function$;
revoke all on function public.norva_get_credential_transport_check(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_get_credential_transport_check(uuid,uuid) to service_role;

-- A lease-bound service caller has already compared all credential fields in
-- memory and authenticated the candidate. No credential bytes are persisted
-- here. The ciphertext digest binds this proof to that exact encrypted request.
create or replace function public.norva_begin_credential_transport_check(
  p_job_id uuid,p_user_id uuid,p_worker text,p_lease_sequence integer
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  j public.cloud_source_credential_transition_jobs%rowtype;
  t public.cloud_source_transitions%rowtype;
  h public.cloud_source_catalog_heads%rowtype;
  g public.cloud_source_catalog_generations%rowtype;
  v_manifest jsonb;
begin
  perform public.norva_credential_require_service_role();
  perform public.norva_credential_require_enabled();
  select * into j from public.cloud_source_credential_transition_jobs
    where id=p_job_id and user_id=p_user_id;
  select * into t from public.cloud_source_transitions
    where id=j.transition_id and user_id=p_user_id for update;
  select * into j from public.cloud_source_credential_transition_jobs
    where id=p_job_id and user_id=p_user_id for update;
  if j.id is null or t.id is null or t.transition_kind<>'credential' or t.state<>'validating'
    or j.job_kind<>'validate_candidate' or j.state<>'processing'
    or j.lease_owner is distinct from p_worker or j.lease_sequence is distinct from p_lease_sequence
    or j.lease_until<=clock_timestamp() then
    raise exception 'transport validation lease CAS failed' using errcode='PT409';
  end if;
  if exists(select 1 from public.cloud_source_transport_checks where transition_id=t.id) then
    return public.norva_get_credential_transport_check(t.id,p_user_id);
  end if;
  select * into h from public.cloud_source_catalog_heads
    where source_id=t.old_source_id and user_id=p_user_id for update;
  select * into g from public.cloud_source_catalog_generations
    where id=h.active_generation_id and user_id=p_user_id for update;
  if g.id is null or g.state<>'active' or g.manifest_sealing or g.config_revision<>t.expected_source_revision then
    return jsonb_build_object('state','NOT_APPLICABLE');
  end if;
  v_manifest:=public.norva_transport_catalog_manifest(g.id);
  if (v_manifest->>'count')::bigint<32 then return jsonb_build_object('state','NOT_APPLICABLE'); end if;
  insert into public.cloud_source_transport_checks(transition_id,user_id,source_id,generation_id,
    head_revision,generation_revision,config_revision,baseline_checksum,baseline_count,candidate_ciphertext_hash)
  select t.id,p_user_id,t.old_source_id,g.id,h.head_revision,g.revision,t.expected_source_revision,
    v_manifest->>'checksum',(v_manifest->>'count')::bigint,
    encode(extensions.digest(secret.candidate_config_ciphertext,'sha256'),'hex')
  from public.cloud_source_transition_secrets secret
  where secret.transition_id=t.id and secret.user_id=p_user_id and secret.cleared_at is null;
  return public.norva_get_credential_transport_check(t.id,p_user_id);
end
$function$;
revoke all on function public.norva_begin_credential_transport_check(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.norva_begin_credential_transport_check(uuid,uuid,text,integer) to service_role;

create or replace function public.norva_transport_check_current(p_transition_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
 select exists(select 1 from public.cloud_source_transport_checks p
   join public.cloud_source_transitions t on t.id=p.transition_id and t.user_id=p.user_id
   join public.cloud_source_catalog_heads h on h.source_id=p.source_id and h.user_id=p.user_id
   join public.cloud_source_catalog_generations g on g.id=p.generation_id and g.user_id=p.user_id
   join public.cloud_source_lifecycle l on l.source_id=p.source_id and l.user_id=p.user_id
   join public.cloud_source_transition_secrets s on s.transition_id=p.transition_id and s.user_id=p.user_id
   where p.transition_id=p_transition_id and p.user_id=p_user_id and p.state='ready'
     and p.checked_at>now()-interval '15 minutes' and t.transition_kind='credential'
     and t.candidate_catalog_generation_id is null and t.previous_catalog_generation_id=p.generation_id
     and h.active_generation_id=p.generation_id and h.head_revision=p.head_revision
     and g.state='active' and not g.manifest_sealing and g.revision=p.generation_revision
     and l.config_revision=p.config_revision and g.config_revision=p.config_revision
     and s.cleared_at is null and s.swap_applied_at is null
     and encode(extensions.digest(s.candidate_config_ciphertext,'sha256'),'hex')=p.candidate_ciphertext_hash)
$function$;
revoke all on function public.norva_transport_check_current(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.norva_catalog_background_owner_transition_guard()
returns trigger language plpgsql volatile security definer set search_path = ''
as $function$
begin
  if new.transition_kind<>'credential' or tg_op='INSERT' then return new; end if;
  if new.state in ('ready_to_switch','committing') and old.state is distinct from new.state
    and not public.norva_transport_check_current(new.id,new.user_id)
    and not public.norva_catalog_background_owner_candidate_current(new.id,new.user_id) then
    raise exception 'catalog background owner candidate is not ready'
      using errcode='55000',detail='reason=catalog_background_owner_candidate_missing';
  end if;
  return new;
end
$function$;

create or replace function public.norva_checkpoint_credential_transport_check(
  p_job_id uuid,p_user_id uuid,p_worker text,p_lease_sequence integer,
  p_item_type text,p_manifest jsonb,p_retry_after integer default 2
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
 j public.cloud_source_credential_transition_jobs%rowtype;
 t public.cloud_source_transitions%rowtype;
 p public.cloud_source_transport_checks%rowtype;
 v_part jsonb; v_count bigint:=0; v_sums numeric[]:=array[0,0,0,0]::numeric[];
 v_xors bigint[]:=array[0,0,0,0]::bigint[]; v_lane integer; v_checksum text; v_generation_revision bigint;
begin
 perform public.norva_credential_require_service_role();
 select * into j from public.cloud_source_credential_transition_jobs where id=p_job_id and user_id=p_user_id;
 select * into t from public.cloud_source_transitions where id=j.transition_id and user_id=p_user_id for update;
 select * into j from public.cloud_source_credential_transition_jobs where id=p_job_id and user_id=p_user_id for update;
 select * into p from public.cloud_source_transport_checks where transition_id=t.id and user_id=p_user_id for update;
 if j.id is null or t.id is null or p.transition_id is null or t.state<>'validating'
   or j.job_kind<>'validate_candidate' or j.state<>'processing' or j.lease_owner is distinct from p_worker
   or j.lease_sequence is distinct from p_lease_sequence or j.lease_until<=clock_timestamp()
   or p.state<>'checking' then raise exception 'transport checkpoint CAS failed' using errcode='PT409'; end if;
 if p_item_type is null or p_item_type not in ('movie','series','live')
   or p_retry_after is null or p_retry_after not between 1 and 60 then
   raise exception 'invalid transport checkpoint' using errcode='22023'; end if;
 if p_manifest is not null then
   if jsonb_typeof(p_manifest)<>'object' or octet_length(p_manifest::text)>2048
     or p_manifest->>'version' is distinct from '2' or p_manifest->>'itemType' is distinct from p_item_type
     or exists(select 1 from jsonb_object_keys(p_manifest) k where k not in ('version','itemType','eligible','count','sums','xors')) then
     raise exception 'invalid transport manifest' using errcode='22023'; end if;
   if p_manifest->>'eligible' is distinct from 'true' then
     update public.cloud_source_transport_checks set state='not_matching' where transition_id=t.id;
     return public.norva_get_credential_transport_check(t.id,p_user_id);
   end if;
   if coalesce(p_manifest->>'count','')!~'^[0-9]{1,7}$' or (p_manifest->>'count')::bigint>1000000
     or jsonb_typeof(p_manifest->'sums') is distinct from 'array' or jsonb_array_length(p_manifest->'sums')<>4
     or jsonb_typeof(p_manifest->'xors') is distinct from 'array' or jsonb_array_length(p_manifest->'xors')<>4 then
     raise exception 'invalid transport lanes' using errcode='22023'; end if;
   for v_lane in 0..3 loop
     if coalesce(p_manifest->'sums'->>v_lane,'')!~'^-?[0-9]{1,26}$'
       or coalesce(p_manifest->'xors'->>v_lane,'')!~'^-?[0-9]{1,20}$' then
       raise exception 'invalid transport lane value' using errcode='22023'; end if;
     perform (p_manifest->'xors'->>v_lane)::bigint;
   end loop;
   if p.parts ? p_item_type and p.parts->p_item_type is distinct from p_manifest then
     raise exception 'transport inventory changed' using errcode='PT409'; end if;
   update public.cloud_source_transport_checks set parts=parts||jsonb_build_object(p_item_type,p_manifest)
     where transition_id=t.id returning * into p;
 end if;
 if p.parts ?& array['movie','series','live'] then
   for v_part in select value from jsonb_each(p.parts) loop
     v_count:=v_count+(v_part->>'count')::bigint;
     for v_lane in 1..4 loop
       v_sums[v_lane]:=v_sums[v_lane]+(v_part->'sums'->>(v_lane-1))::numeric;
       v_xors[v_lane]:=v_xors[v_lane] # (v_part->'xors'->>(v_lane-1))::bigint;
     end loop;
   end loop;
   v_checksum:=encode(extensions.digest(jsonb_build_array('norva-catalog-content-manifest-v2',v_count,
     v_sums[1]::text,v_xors[1]::text,v_sums[2]::text,v_xors[2]::text,
     v_sums[3]::text,v_xors[3]::text,v_sums[4]::text,v_xors[4]::text)::text,'sha256'),'hex');
   if v_checksum<>p.baseline_checksum or v_count<>p.baseline_count or p.checked_at<=now()-interval '15 minutes' then
     update public.cloud_source_transport_checks set state='not_matching' where transition_id=t.id;
     return public.norva_get_credential_transport_check(t.id,p_user_id);
   end if;
   perform 1 from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l
     on l.source_id=h.source_id and l.user_id=h.user_id
     where h.source_id=p.source_id and h.user_id=p_user_id and h.active_generation_id=p.generation_id
       and h.head_revision=p.head_revision and l.config_revision=p.config_revision for update of h,l;
   if not found then raise exception 'transport source changed during verification' using errcode='PT409'; end if;
   select revision into v_generation_revision from public.cloud_source_catalog_generations
     where id=p.generation_id and user_id=p_user_id and state='active' and not manifest_sealing for update;
   if not found then raise exception 'transport generation changed during verification' using errcode='PT409'; end if;
   if public.norva_transport_catalog_manifest(p.generation_id)->>'checksum' is distinct from p.baseline_checksum then
     update public.cloud_source_transport_checks set state='not_matching' where transition_id=t.id;
     return public.norva_get_credential_transport_check(t.id,p_user_id);
   end if;
   update public.cloud_source_transport_checks set state='ready',generation_revision=v_generation_revision where transition_id=t.id;
   update public.cloud_source_transitions set state='staging',previous_catalog_generation_id=p.generation_id where id=t.id;
   update public.cloud_source_transitions set state='importing' where id=t.id;
   insert into public.cloud_source_identity_assessments(user_id,transition_id,algorithm_version,
     sample_size_old,sample_size_new,overlap_count,similarity_score,secondary_signals,
     automatic_decision,final_decision,decision_origin,decided_at)
   values(p_user_id,t.id,'xtream-exact-transport-manifest-v2',v_count,v_count,v_count,1,
     jsonb_build_object('completeInventoryMatch',true),'same_catalog','same_catalog','automatic',now());
   update public.cloud_source_transitions set identity_decision='same_catalog',decision_origin='automatic',
     readiness_check_id=t.id,readiness_passed_at=now() where id=t.id;
   update public.cloud_source_transitions set state='ready_to_switch' where id=t.id;
   update public.cloud_source_credential_transition_jobs set state='completed',lease_owner=null,lease_until=null,
     completed_at=now(),last_error_code=null where id=j.id;
 else
   update public.cloud_source_credential_transition_jobs set state='pending',lease_owner=null,lease_until=null,
     available_at=now()+make_interval(secs=>p_retry_after),checkpoint_revision=checkpoint_revision+1 where id=j.id;
 end if;
 return public.norva_get_credential_transport_check(t.id,p_user_id);
end
$function$;
revoke all on function public.norva_checkpoint_credential_transport_check(uuid,uuid,text,integer,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.norva_checkpoint_credential_transport_check(uuid,uuid,text,integer,text,jsonb,integer) to service_role;

create or replace function public.norva_apply_credential_transport_check(
 p_transition_id uuid,p_user_id uuid,p_expected_transition_revision bigint,
 p_expected_source_revision bigint,p_idempotency_key text,p_request_fingerprint text
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
 t public.cloud_source_transitions%rowtype;
 p public.cloud_source_transport_checks%rowtype;
 s public.cloud_source_transition_secrets%rowtype;
 a public.cloud_source_credential_transition_actions%rowtype;
 g public.cloud_source_catalog_generations%rowtype;
 v_result jsonb;
begin
 perform public.norva_credential_require_service_role();
 perform public.norva_credential_require_enabled();
 if p_idempotency_key is null or btrim(p_idempotency_key)='' or length(p_idempotency_key)>200
   or p_request_fingerprint is null or p_request_fingerprint!~'^[a-f0-9]{64}$' then
   raise exception 'invalid action identity' using errcode='22023'; end if;
 perform public.norva_credential_lock_account(p_user_id);
 perform public.norva_lock_credential_transition_account_affinities(p_transition_id,p_user_id);
 select * into a from public.cloud_source_credential_transition_actions
   where user_id=p_user_id and idempotency_key=p_idempotency_key;
 if found then
   if a.transition_id=p_transition_id and a.action_kind='begin_swap' and a.request_fingerprint=p_request_fingerprint then
     return public.norva_credential_action_result(a.id); end if;
   raise exception 'action identity reused' using errcode='22023';
 end if;
 select * into t from public.cloud_source_transitions where id=p_transition_id and user_id=p_user_id for update;
 select * into p from public.cloud_source_transport_checks where transition_id=p_transition_id and user_id=p_user_id for update;
 perform 1 from public.cloud_sources where id=p.source_id and user_id=p_user_id for update;
 perform 1 from public.cloud_source_lifecycle where source_id=p.source_id and user_id=p_user_id for update;
 perform 1 from public.cloud_source_catalog_heads where source_id=p.source_id and user_id=p_user_id for update;
 select * into g from public.cloud_source_catalog_generations where id=p.generation_id and user_id=p_user_id for update;
 select * into s from public.cloud_source_transition_secrets where transition_id=p_transition_id and user_id=p_user_id for update;
 if t.id is null or p.transition_id is null or g.id is null or s.transition_id is null
   or t.state<>'ready_to_switch' or t.revision is distinct from p_expected_transition_revision
   or t.expected_source_revision is distinct from p_expected_source_revision
   or p.config_revision is distinct from p_expected_source_revision then
   raise exception 'transport apply CAS failed' using errcode='PT409'; end if;
 -- Recheck the actual current rows, not a stale generation manifest. The
 -- generation lock serializes the physical writer's AFTER-statement fence.
 if public.norva_transport_catalog_manifest(g.id)->>'checksum' is distinct from p.baseline_checksum then
   raise exception 'catalog changed after address verification' using errcode='PT409'; end if;
 update public.cloud_source_transport_checks set generation_revision=g.revision where transition_id=t.id;
 if not public.norva_transport_check_current(t.id,p_user_id) then
   raise exception 'transport proof is no longer current' using errcode='PT409'; end if;
 update public.cloud_source_transitions set state='committing' where id=t.id;
 update public.cloud_sources set config_ciphertext=s.candidate_config_ciphertext,
   config_hint=s.candidate_config_hint,updated_at=now() where id=p.source_id and user_id=p_user_id;
 -- Keep every item, episode membership and owner pointer. A short write seal
 -- also aborts an old-config writer that was already waiting on this row.
 update public.cloud_source_catalog_generations set config_revision=p.config_revision+1,
   revision=revision+1,manifest_sealing=true,updated_at=now() where id=p.generation_id;
 update public.cloud_source_catalog_heads set head_revision=head_revision+1,updated_at=now()
   where source_id=p.source_id and user_id=p_user_id;
 update public.cloud_source_transition_secrets set swap_applied_at=now() where transition_id=t.id;
 update public.cloud_source_transport_checks set state='applied',applied_at=now() where transition_id=t.id;
 insert into public.cloud_source_credential_transition_jobs(user_id,transition_id,source_id,catalog_generation_id,
   expected_source_revision,job_kind) values(p_user_id,t.id,p.source_id,p.generation_id,p.config_revision+1,'post_switch_verify');
 insert into public.cloud_source_lifecycle_events(user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor)
 values(p_user_id,p.source_id,t.id,'credential_transport_applied','credential-transport:'||t.id||':applied',
   jsonb_build_object('catalogReused',true,'sourceRevision',p.config_revision+1),'service_role');
 v_result:=public.norva_credential_transition_result(t.id,p_user_id);
 insert into public.cloud_source_credential_transition_actions(user_id,transition_id,action_kind,idempotency_key,
   request_fingerprint,result_state,result_revision,result_identity_decision,result_payload)
 values(p_user_id,t.id,'begin_swap',p_idempotency_key,p_request_fingerprint,'committing',
   (v_result->>'revision')::bigint,'same_catalog',v_result);
 return v_result;
end
$function$;
revoke all on function public.norva_apply_credential_transport_check(uuid,uuid,bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.norva_apply_credential_transport_check(uuid,uuid,bigint,bigint,text,text) to service_role;

create or replace function public.norva_finish_credential_transport_check(
 p_job_id uuid,p_user_id uuid,p_worker text,p_lease_sequence integer,p_restore_previous boolean default false,
 p_failure_code text default null
) returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
 j public.cloud_source_credential_transition_jobs%rowtype;
 t public.cloud_source_transitions%rowtype;
 p public.cloud_source_transport_checks%rowtype;
 s public.cloud_source_transition_secrets%rowtype;
 v_ciphertext text; v_revision bigint;
begin
 perform public.norva_credential_require_service_role();
 select * into j from public.cloud_source_credential_transition_jobs where id=p_job_id and user_id=p_user_id;
 perform public.norva_credential_lock_account(p_user_id);
 perform public.norva_lock_credential_transition_account_affinities(j.transition_id,p_user_id);
 select * into t from public.cloud_source_transitions where id=j.transition_id and user_id=p_user_id for update;
 select * into j from public.cloud_source_credential_transition_jobs where id=p_job_id and user_id=p_user_id for update;
 select * into p from public.cloud_source_transport_checks where transition_id=t.id and user_id=p_user_id for update;
 select * into s from public.cloud_source_transition_secrets where transition_id=t.id and user_id=p_user_id for update;
 select config_ciphertext into v_ciphertext from public.cloud_sources where id=p.source_id and user_id=p_user_id for update;
 select config_revision into v_revision from public.cloud_source_lifecycle where source_id=p.source_id and user_id=p_user_id for update;
 perform 1 from public.cloud_source_catalog_heads where source_id=p.source_id and user_id=p_user_id
   and active_generation_id=p.generation_id and head_revision=p.head_revision+1 for update;
 if not found or j.id is null or p.transition_id is null or s.transition_id is null
   or t.state<>'committing' or p.state<>'applied' or j.job_kind<>'post_switch_verify'
   or j.state<>'processing' or j.lease_owner is distinct from p_worker
   or j.lease_sequence is distinct from p_lease_sequence or j.lease_until<=clock_timestamp()
   or v_ciphertext is distinct from s.candidate_config_ciphertext or v_revision is distinct from p.config_revision+1
   or p_restore_previous is null or (p_failure_code is not null and (p_failure_code<>'rollback_unavailable' or p_restore_previous))
   then raise exception 'transport completion CAS failed' using errcode='PT409'; end if;
 if p_restore_previous then
   -- Caller authenticated the retained credentials before requesting recovery.
   update public.cloud_source_transition_secrets set compensation_started_at=now(),
     compensation_reason_code='candidate_auth_rejected' where transition_id=t.id;
   update public.cloud_sources set config_ciphertext=s.previous_config_ciphertext,
     config_hint=s.previous_config_hint,updated_at=now() where id=p.source_id and user_id=p_user_id;
   update public.cloud_source_catalog_heads set head_revision=head_revision+1,updated_at=now()
     where source_id=p.source_id and user_id=p_user_id;
   update public.cloud_source_transition_secrets set previous_config_restored_at=now() where transition_id=t.id;
 end if;
 update public.cloud_source_catalog_generations set config_revision=p.config_revision+case when p_restore_previous then 2 else 1 end,
   manifest_sealing=false,revision=revision+1,updated_at=now() where id=p.generation_id and user_id=p_user_id;
 update public.cloud_source_transport_checks set state=case when p_restore_previous then 'rolled_back' when p_failure_code is not null then 'not_matching' else 'completed' end,
   completed_at=now() where transition_id=t.id;
 update public.cloud_source_transitions set state=case when p_restore_previous or p_failure_code is not null then 'failed' else 'completed' end,
   failure_code=case when p_restore_previous then 'candidate_auth_rejected' else p_failure_code end where id=t.id;
 update public.cloud_source_credential_transition_jobs set state='completed',lease_owner=null,lease_until=null,
   completed_at=now(),last_error_code=null where id=j.id;
 perform set_config('norva.credential_secret_clear','on',true);
 update public.cloud_source_transition_secrets set candidate_config_ciphertext=null,previous_config_ciphertext=null,
   candidate_config_hint=null,previous_config_hint=null,cleared_at=now() where transition_id=t.id;
 perform set_config('norva.credential_secret_clear','off',true);
 insert into public.cloud_source_lifecycle_events(user_id,source_id,transition_id,event_kind,idempotency_key,payload,actor)
 values(p_user_id,p.source_id,t.id,'credential_transport_finished','credential-transport:'||t.id||':finished',
   jsonb_build_object('catalogReused',true,'restoredPrevious',p_restore_previous,'failureCode',p_failure_code),'service_role');
 return public.norva_credential_transition_result(t.id,p_user_id);
end
$function$;
revoke all on function public.norva_finish_credential_transport_check(uuid,uuid,text,integer,boolean,text) from public,anon,authenticated;
grant execute on function public.norva_finish_credential_transport_check(uuid,uuid,text,integer,boolean,text) to service_role;

commit;
