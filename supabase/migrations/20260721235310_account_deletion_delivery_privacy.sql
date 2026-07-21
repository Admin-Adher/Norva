-- Do not retain a deleted account's former recipient address in the shared
-- Resend webhook ledger. Provider ids, non-PII tags and delivery timestamps are
-- sufficient to measure confirmation deliverability.

create or replace function public.norva_minimize_account_deleted_delivery()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if coalesce(new.tags ->> 'app', '') = 'norva'
     and coalesce(new.tags ->> 'flow', '') = 'account_deleted' then
    new.to_emails := '{}'::text[];
  end if;
  return new;
end
$function$;

drop trigger if exists norva_minimize_account_deleted_event_trg
  on public.cloud_email_delivery_events;
create trigger norva_minimize_account_deleted_event_trg
  before insert or update on public.cloud_email_delivery_events
  for each row execute function public.norva_minimize_account_deleted_delivery();

drop trigger if exists norva_minimize_account_deleted_status_trg
  on public.cloud_email_delivery_status;
create trigger norva_minimize_account_deleted_status_trg
  before insert or update on public.cloud_email_delivery_status
  for each row execute function public.norva_minimize_account_deleted_delivery();

create or replace function public.norva_skip_deleted_account_suppression()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if exists (
    select 1
    from public.cloud_email_delivery_status d
    where d.provider_email_id = new.source_email_id
      and coalesce(d.tags ->> 'app', '') = 'norva'
      and coalesce(d.tags ->> 'flow', '') = 'account_deleted'
  ) then
    return null;
  end if;
  return new;
end
$function$;

drop trigger if exists norva_skip_deleted_account_suppression_trg
  on public.cloud_email_suppressions;
create trigger norva_skip_deleted_account_suppression_trg
  before insert or update on public.cloud_email_suppressions
  for each row execute function public.norva_skip_deleted_account_suppression();

-- Minimize rows received between the base observability deployment and this
-- hardening migration, including any derived suppression entry.
delete from public.cloud_email_suppressions s
using public.cloud_email_delivery_status d
where s.source_email_id = d.provider_email_id
  and coalesce(d.tags ->> 'app', '') = 'norva'
  and coalesce(d.tags ->> 'flow', '') = 'account_deleted';

update public.cloud_email_delivery_events e
set to_emails = '{}'::text[]
where coalesce(e.tags ->> 'app', '') = 'norva'
  and coalesce(e.tags ->> 'flow', '') = 'account_deleted'
  and cardinality(e.to_emails) > 0;

update public.cloud_email_delivery_status d
set to_emails = '{}'::text[],
    updated_at = clock_timestamp()
where coalesce(d.tags ->> 'app', '') = 'norva'
  and coalesce(d.tags ->> 'flow', '') = 'account_deleted'
  and cardinality(d.to_emails) > 0;

comment on table public.cloud_email_delivery_events is
  'Service-only, append-only Resend delivery event ledger. No bodies, links, IPs or user agents are retained; account-deletion confirmation recipients are redacted immediately.';
comment on table public.cloud_email_delivery_status is
  'Monotonic per-message Resend delivery projection. Account-deletion confirmation recipients are redacted immediately.';

revoke all on function public.norva_minimize_account_deleted_delivery()
  from public, anon, authenticated;
revoke all on function public.norva_skip_deleted_account_suppression()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
