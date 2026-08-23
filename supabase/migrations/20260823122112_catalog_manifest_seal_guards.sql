begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create or replace function public.norva_release_catalog_manifest_seal_on_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.transition_kind = 'credential'
     and new.state in ('failed','cancelled','completed')
     and new.state is distinct from old.state then
    update public.cloud_source_catalog_generations generation
    set manifest_sealing = false,
        revision = generation.revision + 1,
        updated_at = clock_timestamp()
    where generation.id in (
      new.candidate_catalog_generation_id,
      new.previous_catalog_generation_id
    ) and generation.manifest_sealing;
    -- Progress is scratch state only.  Removing it in the same terminal
    -- transaction prevents its restrictive generation/transition FKs from
    -- pinning failed or superseded generations forever.
    delete from public.cloud_source_catalog_manifest_seal_progress progress
    where progress.seal_transition_id = new.id
      and progress.user_id = new.user_id;
  end if;
  return new;
end
$function$;

create or replace function public.norva_candidate_title_manifest_seal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_generation_id uuid := case when tg_op='DELETE'
    then old.generation_id else new.generation_id end;
begin
  if exists (
    select 1
    from public.cloud_source_catalog_generations generation
    where generation.id = v_generation_id
      and generation.manifest_sealing
  ) then
    raise exception 'candidate title projection is sealed for manifest snapshot'
      using errcode = '40001', detail = 'reason=manifest_sealing';
  end if;
  return case when tg_op='DELETE' then old else new end;
end
$function$;

revoke all on function public.norva_release_catalog_manifest_seal_on_terminal()
from public, anon, authenticated, service_role;
revoke all on function public.norva_candidate_title_manifest_seal_guard()
from public, anon, authenticated, service_role;

commit;
