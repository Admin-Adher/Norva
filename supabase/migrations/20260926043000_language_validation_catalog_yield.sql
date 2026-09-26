begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Waiting audio work asks future catalogue requests to yield. This never
-- changes the foreground activity ledger or grants a provider connection.
create table public.provider_catalog_yield_requests (
  job_id uuid not null references public.catalog_file_audio_validation_jobs(id) on delete cascade,
  account_key_hash text primary key check (account_key_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  window_until timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index provider_catalog_yield_job_idx on public.provider_catalog_yield_requests(job_id);
alter table public.provider_catalog_yield_requests enable row level security;
revoke all on public.provider_catalog_yield_requests from public, anon, authenticated;

create function public.request_language_validation_catalog_yield(
  p_job_id uuid, p_lease_owner text, p_account_key text
) returns boolean language plpgsql security definer set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_hash text;
  v_granted boolean := false;
begin
  if p_job_id is null or coalesce(p_lease_owner,'') = ''
     or coalesce(p_account_key,'') = '' or length(p_account_key)>300 then return false; end if;
  -- The service caller resolves the account from the revalidated owned file.
  -- A stale worker cannot reserve catalogue priority for another job lease.
  perform 1 from public.catalog_file_audio_validation_jobs j
    where j.id=p_job_id and j.state='running' and j.lease_owner=p_lease_owner
      and j.lease_expires_at>v_now and j.quarantined_at is null for update;
  if not found then return false; end if;
  v_hash := encode(extensions.digest(p_account_key,'sha256'),'hex');
  insert into public.provider_catalog_yield_requests as held
    (job_id,account_key_hash,expires_at,window_until,updated_at)
    values(p_job_id,v_hash,v_now+interval '90 seconds',v_now+interval '10 minutes',v_now)
  on conflict(account_key_hash) do update set
    job_id=excluded.job_id,
    expires_at=case when held.window_until+interval '2 minutes'<=v_now
      then v_now+interval '90 seconds'
      else least(held.window_until,v_now+interval '90 seconds') end,
    window_until=case when held.window_until+interval '2 minutes'<=v_now
      then v_now+interval '10 minutes' else held.window_until end,
    updated_at=v_now
    where held.window_until>v_now or held.window_until+interval '2 minutes'<=v_now
  returning true into v_granted;
  return coalesce(v_granted,false);
end
$function$;

create or replace function public.provider_account_busy_for_catalog_refresh(p_key text)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((select bool_or(
      activity.last_seen_at>statement_timestamp()-interval '5 minutes'
      and activity.kind is distinct from 'presence'
      and activity.kind is distinct from 'catalog-refresh'
      and activity.kind is distinct from 'catalog-metadata'
    ) from public.provider_account_activity activity
    where activity.account_key in (p_key,encode(extensions.digest(p_key,'sha256'),'hex'))),false)
    or exists(select 1 from public.provider_catalog_yield_requests held
      join public.catalog_file_audio_validation_jobs job on job.id=held.job_id
      where held.account_key_hash in (p_key,encode(extensions.digest(p_key,'sha256'),'hex'))
        and held.expires_at>statement_timestamp()
        and job.state in ('queued','running','retry_wait','finalizing')
        and job.quarantined_at is null);
$function$;

revoke all on function public.request_language_validation_catalog_yield(uuid,text,text),
  public.provider_account_busy_for_catalog_refresh(text) from public,anon,authenticated;
grant execute on function public.request_language_validation_catalog_yield(uuid,text,text),
  public.provider_account_busy_for_catalog_refresh(text) to service_role;
commit;
