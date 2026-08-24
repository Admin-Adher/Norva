begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The longest incompatible browser cache is seven days. This observation
-- period is an integrity gate, not an operator convention: even service_role
-- cannot complete epoch v2 before the database-derived deadline.
create or replace function public.norva_complete_catalog_cache_epoch_v2_rollout(
  p_contract text,
  p_manifest_sha256 text
) returns jsonb
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare
  v_role text:=coalesce(nullif(current_setting('role',true),'none'),'');
  v_rollout public.cloud_catalog_cache_epoch_v2_rollout%rowtype;
  v_not_before timestamptz;
begin
  if v_role<>'service_role'
     and not (
       v_role in ('','postgres','supabase_admin')
       and session_user in ('postgres','supabase_admin')
     ) then
    raise exception 'service role required' using errcode='42501';
  end if;
  if p_contract is distinct from 'catalog-cache-epoch-v2'
     or p_manifest_sha256 is distinct from
       '23c0fa2cdaf09c08d9de4378d1a82f0f631ce71d6f955a0bdbb2c786b8ff98d3' then
    raise exception 'catalog cache epoch v2 manifest mismatch'
      using errcode='22023';
  end if;

  select rollout.* into strict v_rollout
  from public.cloud_catalog_cache_epoch_v2_rollout rollout
  where rollout.singleton
  for update;
  v_not_before := v_rollout.installed_at + interval '7 days';

  if v_rollout.phase='complete' then
    if v_rollout.contract is distinct from p_contract
       or v_rollout.manifest_sha256 is distinct from p_manifest_sha256 then
      raise exception 'catalog cache epoch v2 completion is immutable'
        using errcode='22023';
    end if;
  else
    if clock_timestamp() < v_not_before then
      raise exception 'catalog cache epoch v2 observation window is incomplete'
        using errcode='55000',
          detail='reason=observation_window;not_before=' || v_not_before::text;
    end if;
    update public.cloud_catalog_cache_epoch_v2_rollout rollout
    set phase='complete',
        manifest_sha256=p_manifest_sha256,
        completed_at=clock_timestamp(),
        updated_at=clock_timestamp()
    where rollout.singleton
    returning rollout.* into strict v_rollout;
    perform public.norva_bump_global_catalog_visibility_epoch();
  end if;

  return jsonb_build_object(
    'contract',v_rollout.contract,
    'phase',upper(v_rollout.phase),
    'manifestSha256',v_rollout.manifest_sha256,
    'completedAt',v_rollout.completed_at,
    'notBefore',v_not_before
  );
end
$function$;

comment on function public.norva_complete_catalog_cache_epoch_v2_rollout(text,text)
is 'Completes immutable cache epoch v2 only after the database-enforced seven-day incompatible-cache observation window.';

commit;
