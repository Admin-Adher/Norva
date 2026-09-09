begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Pure identity verification only. Existing lifecycle/head/owner fences remain
-- responsible for access; neither names nor client metadata confer membership.
create or replace function public.norva_selection_source_identity_valid(
  p_source_id uuid, p_user_id uuid
) returns boolean
language plpgsql immutable security invoker set search_path = '' as $function$
declare
  v_hash text;
  v_expected uuid;
  v_generation bigint;
begin
  if p_source_id is null or p_user_id is null then return false; end if;
  v_hash := encode(sha256(convert_to('norva-selection-curated-v1:' || p_user_id::text, 'UTF8')), 'hex');
  v_expected := (substr(v_hash,1,8) || '-' || substr(v_hash,9,4) || '-4' || substr(v_hash,14,3)
    || '-a' || substr(v_hash,18,3) || '-' || substr(v_hash,21,12))::uuid;
  if p_source_id = v_expected then return true; end if;
  v_generation := ('x' || right(p_source_id::text,8))::bit(32)::bigint;
  if v_generation = 0 then return false; end if;
  v_hash := encode(sha256(convert_to('norva-selection-enrolment-v1:' || v_generation::text || ':' || p_user_id::text, 'UTF8')), 'hex');
  v_expected := (substr(v_hash,1,8) || '-' || substr(v_hash,9,4) || '-4' || substr(v_hash,14,3)
    || '-a' || substr(v_hash,18,3) || '-' || substr(v_hash,21,4) || right(p_source_id::text,8))::uuid;
  return p_source_id = v_expected;
end
$function$;
revoke all on function public.norva_selection_source_identity_valid(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_selection_source_identity_valid(uuid,uuid) to service_role;

-- Extend only the existing identity check. Preserve every service, tenant,
-- catalogue-generation, visibility and exact-file guard in the live function.
do $patch$
declare
  v_definition text;
  v_old text := $old$  v_hash := encode(sha256(convert_to('norva-selection-curated-v1:' || p_user_id::text, 'UTF8')), 'hex');
  v_source_id := (substr(v_hash,1,8) || '-' || substr(v_hash,9,4) || '-4' || substr(v_hash,14,3)
    || '-a' || substr(v_hash,18,3) || '-' || substr(v_hash,21,12))::uuid;
  if p_user_id is null or p_source_id is distinct from v_source_id then
$old$;
  v_new text := E'  -- selection_reenrollment_identity_v1\n  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then\n';
begin
  select replace(pg_get_functiondef('public.hydrate_selection_episode_file_languages(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text[])'::regprocedure),chr(13),'') into v_definition;
  if position('selection_reenrollment_identity_v1' in v_definition) = 0 then
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'Selection hydration identity check drifted' using errcode='55000';
    end if;
    execute replace(v_definition,v_old,v_new);
  end if;
end
$patch$;
notify pgrst, 'reload schema';
commit;
