-- One-shot operator repair authorized 2026-09-04. NOT a migration or cron.
-- Run only after lid-canary-smoke.py and both replica health checks pass.
-- Replay is rejected by expected expiry and predecessor CAS.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
select singleton from public.cloud_provider_access_rollout where singleton for update;
select pg_advisory_xact_lock(hashtext('norva:lid-cascade-canary-lease'));
do $guard$
begin
  if not exists (
    select 1 from public.audio_lid_cascade_policy
    where singleton and expires_at = '2026-08-28T06:59:05.123686+00:00'
      and canary_bps = 1000 and daily_cap = 60
  ) then raise exception 'LID policy drift; stop and audit again'; end if;
  if public.audio_lid_cascade_lease_health()->>'state' <> 'expired' then
    raise exception 'LID lease is no longer expired';
  end if;
  if not exists (
    select 1 from public.catalog_file_audio_validation_jobs
    where id = '5df2bccb-cae4-47fb-97f1-95c1efdc95b3'
      and state = 'failed' and attempt_count = 135 and lease_owner is null
      and error_code = 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'
  ) then raise exception 'Incident job quarantine drift'; end if;
  perform public.norva_assert_provider_access_rollout_safe();
end
$guard$;
select public.renew_audio_lid_cascade_canary(
  'Operator authorized 2026-09-04: worker protocol2 healthy; internal speech/silence tests passed; cohort10pct cap60 unchanged'
) as renewal;
set local role service_role;
select public.norva_restart_provider_access_rollout_observation_after_change(
  '783ef466-1485-4274-bd20-dfd6c89f0559', 16,
  'LID canary restored after expiry; unchanged 10 percent cohort and 60/day cap; reviewed internal inference and viewer preemption',
  'adrien-authorized-lid-repair-20260904'
) as observation;
select public.audio_lid_cascade_lease_health() as lease_health;
commit;
