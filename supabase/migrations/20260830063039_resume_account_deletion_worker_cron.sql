-- The account-deletion Edge worker drains three independent durable queues:
-- workflow stages, Auth finalizations, and confirmation emails. The original
-- cron predicate only woke it for due emails, which left workflow rows stuck
-- in `stopping` whenever no confirmation email was ready.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $cron_setup$
declare
  v_job_id bigint;
  v_command text := $cron$
    select net.http_post(
      url := 'https://api.norva.tv/functions/v1/norva-account-delete/cron/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'norva_cron_shared_secret'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    )
    where exists (
      select 1
      from public.cloud_account_deletion_workflows workflow
      where workflow.state in (
        'stopping',
        'draining',
        'purging_analytics',
        'archiving_legal',
        'purging_product',
        'ready_to_finalize',
        'finalizing'
      )
    )
    or exists (
      -- Keep the worker alive across the only intentional crash gap: Auth was
      -- deleted but the durable finalization acknowledgement was not written.
      select 1
      from public.cloud_account_deletion_finalizations finalization
      where finalization.state = 'claimed'
    )
    or exists (
      select 1
      from public.cloud_account_deletion_email_outbox outbox
      where outbox.deletion_confirmed_at is not null
        and outbox.next_attempt_at <= now()
        and (
          outbox.state = 'ready'
          or (
            outbox.state = 'processing'
            and outbox.lease_expires_at <= now()
          )
        )
    );
  $cron$;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_namespace where nspname = 'net') then
    select job.jobid
    into v_job_id
    from cron.job job
    where job.jobname = 'norva-account-deletion-email';

    if v_job_id is null then
      perform cron.schedule(
        'norva-account-deletion-email',
        '* * * * *',
        v_command
      );
    else
      perform cron.alter_job(
        v_job_id,
        schedule := '* * * * *',
        command := v_command,
        active := true
      );
    end if;
  end if;
exception
  when undefined_table or invalid_schema_name or insufficient_privilege then
    raise notice 'account deletion cron unavailable; register the worker externally';
end
$cron_setup$;

commit;
