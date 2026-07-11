-- Retire the Stancer billing cron(s) — Stancer is fully removed (replaced by Revolut).
-- The norva-stancer* edge functions were deleted; their pg_cron jobs (registered
-- out-of-band on the self-host, e.g. 'norva-stancer-billing' @ '23 * * * *') would now
-- POST to a 404 every hour. Unschedule any remaining norva-stancer* job.
--
-- Idempotent + guarded: no-op on a box where the job was never registered (fresh clone)
-- or was already removed. Revolut renewals run via 'norva-revolut-billing' (registered by
-- ops/hetzner/scripts/register-revolut-billing-cron.sql).
do $$
declare
  j record;
begin
  for j in select jobname from cron.job where jobname like 'norva-stancer%' loop
    perform cron.unschedule(j.jobname);
    raise notice 'retire-stancer: unscheduled cron job %', j.jobname;
  end loop;
end $$;
