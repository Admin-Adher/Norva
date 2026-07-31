-- =============================================================================
-- Revolut Business Basic cutover: disable every provider/API payout schedule.
--
-- Run explicitly as the pg_cron owner during the controlled cutover. This is
-- recoverable: the rows remain registered but inactive, preserving their
-- operational history. Re-enabling requires a future approved provider route,
-- release evidence and the guarded registration scripts. The Revolut API job is
-- included even though the Basic architecture must never schedule it.
-- =============================================================================

\set ON_ERROR_STOP on

update cron.job
set active = false
where jobname in (
  'norva-partners-payout',
  'norva-partners-airwallex-reports',
  'norva-partners-revolut-api'
)
  and active is distinct from false;

do $verify$
begin
  if exists (
    select 1
    from cron.job
    where jobname in (
      'norva-partners-payout',
      'norva-partners-airwallex-reports',
      'norva-partners-revolut-api'
    )
      and active
  ) then
    raise exception 'a provider/API Partners payout cron is still active';
  end if;
end
$verify$;

select jobid, jobname, schedule, active
from cron.job
where jobname in (
  'norva-partners-payout',
  'norva-partners-airwallex-reports',
  'norva-partners-revolut-api'
)
order by jobname;
