-- Keep the proven internal canary population eligible throughout every active
-- public rollout stage. OFF remains an absolute deny, and non-allowlisted users
-- continue to use the deterministic public cohort assignment.
create or replace function public.norva_provider_access_rollout_eligible_internal(
  p_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select case
      when rollout.stage = 'off' then false
      when exists (
        select 1
        from public.cloud_provider_access_rollout_internal_users member
        where member.user_id = p_user_id
      ) then true
      when rollout.stage = 'internal' then false
      when rollout.stage = '100_percent' then true
      else (
        (
          get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 0)::bigint * 16777216
          + get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 1)::bigint * 65536
          + get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 2)::bigint * 256
          + get_byte(extensions.digest(
            convert_to('provider-access-rollout:v1:' || p_user_id::text, 'UTF8'),
            'sha256'
          ), 3)::bigint
        ) % 10000 < rollout.cohort_basis_points
      )
    end
    from public.cloud_provider_access_rollout rollout
    where rollout.singleton
  ), false);
$function$;

revoke all on function public.norva_provider_access_rollout_eligible_internal(uuid)
  from public, anon, authenticated;
grant execute on function public.norva_provider_access_rollout_eligible_internal(uuid)
  to service_role;

comment on function public.norva_provider_access_rollout_eligible_internal(uuid) is
  'Fail-closed Provider Access eligibility: OFF denies all; the internal allowlist remains eligible at every active stage; all other users follow the deterministic public cohort.';
