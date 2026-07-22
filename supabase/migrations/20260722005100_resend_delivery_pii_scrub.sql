-- Preserve long-horizon deliverability metrics without retaining recipient PII
-- for the full analytical window. The existing daily prune cron calls this
-- function; no additional scheduler or external worker is required.

create or replace function public.norva_prune_resend_delivery_events()
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_deleted bigint;
begin
  -- Ninety days is enough for recipient-level incident investigation. Keep the
  -- event type, provider message id, timestamps and bounded Norva routing tags
  -- after that point, but remove addresses and diagnostic text.
  update public.cloud_email_delivery_events
  set from_email = null,
      to_emails = '{}'::text[],
      diagnostic_data = '{}'::jsonb
  where received_at < now() - interval '90 days'
    and (
      from_email is not null
      or cardinality(to_emails) > 0
      or diagnostic_data <> '{}'::jsonb
    );

  -- The monotonic status supports annual deliverability comparisons for up to
  -- 400 days. Those comparisons require status/timing/tags, not addresses.
  update public.cloud_email_delivery_status
  set from_email = null,
      to_emails = '{}'::text[],
      latest_diagnostic_data = '{}'::jsonb,
      updated_at = now()
  where latest_event_at < now() - interval '90 days'
    and (
      from_email is not null
      or cardinality(to_emails) > 0
      or latest_diagnostic_data <> '{}'::jsonb
    );

  -- Raw event rows expire after six months. Their PII has already been scrubbed
  -- for the second half of this window.
  delete from public.cloud_email_delivery_events
  where received_at < now() - interval '180 days';
  get diagnostics v_deleted = row_count;

  -- Compact, address-free per-message metrics cover a little over one year so
  -- annual billing and seasonal delivery can be compared.
  delete from public.cloud_email_delivery_status
  where latest_event_at < now() - interval '400 days';

  -- Active suppressions must retain the normalized address to prevent another
  -- unsafe send. Resolved entries expire after their cooling-off period.
  delete from public.cloud_email_suppressions
  where not active
    and resolved_at < now() - interval '180 days';

  -- Operator decisions contain no address or raw user id, but their bounded
  -- pseudonymous evidence should not become an indefinite customer history.
  delete from public.cloud_email_suppression_resolution_audit
  where resolved_at < now() - interval '400 days';

  return v_deleted;
end;
$function$;

revoke all on function public.norva_prune_resend_delivery_events()
  from public, anon, authenticated;
grant execute on function public.norva_prune_resend_delivery_events()
  to service_role;

comment on table public.cloud_email_delivery_events is
  'Service-only Resend event ledger. Recipient/from/diagnostic PII is scrubbed after 90 days; address-free rows expire after 180 days.';
comment on table public.cloud_email_delivery_status is
  'Service-only monotonic Resend status. Recipient/from/diagnostic PII is scrubbed after 90 days; address-free metrics expire after 400 days.';
comment on table public.cloud_email_suppression_resolution_audit is
  'Append-only false-bounce resolution evidence. No address/raw user UUID; pseudonymous records expire after 400 days.';
