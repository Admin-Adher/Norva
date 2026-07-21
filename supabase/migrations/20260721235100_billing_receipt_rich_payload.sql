-- Rich, customer-supportable billing receipt payloads.
--
-- Corrective follow-up to 20260721235000: freeze the plain-text alternative,
-- reply-to address and non-PII Resend tags alongside the original HTML payload.
-- Rows prepared by a briefly deployed v1 worker remain replayable byte-for-byte:
-- their new fields stay NULL and the Edge worker omits them on replay.

alter table public.cloud_billing_receipt_outbox
  add column if not exists request_text text,
  add column if not exists request_reply_to text,
  add column if not exists request_tags jsonb;

alter table public.cloud_billing_receipt_outbox
  drop constraint if exists cloud_billing_receipt_outbox_request_check,
  add constraint cloud_billing_receipt_outbox_request_check check (
    -- Not prepared yet.
    (request_from is null and request_subject is null and request_html is null
      and prepared_at is null and request_text is null
      and request_reply_to is null and request_tags is null)
    or
    -- Frozen v1 payload, retained only for rolling-deploy compatibility.
    (request_from is not null and request_subject is not null and request_html is not null
      and prepared_at is not null and request_text is null
      and request_reply_to is null and request_tags is null)
    or
    -- Complete rich payload. Partial enrichment is never valid.
    (request_from is not null and request_subject is not null and request_html is not null
      and prepared_at is not null and request_text is not null
      and request_reply_to is not null and request_tags is not null
      and jsonb_typeof(request_tags) = 'array'
      and jsonb_array_length(request_tags) between 1 and 5)
  );

comment on column public.cloud_billing_receipt_outbox.request_text is
  'Frozen plain-text alternative sent with the HTML receipt.';
comment on column public.cloud_billing_receipt_outbox.request_reply_to is
  'Frozen support reply-to address used by Resend.';
comment on column public.cloud_billing_receipt_outbox.request_tags is
  'Frozen, bounded Resend tags. Values are operational taxonomy only and contain no PII.';

-- Remove the v1 overload so a rolling old worker fails safely before network I/O
-- instead of preparing a newly claimed row without the premium payload fields.
drop function if exists public.prepare_billing_receipt_delivery(text, uuid, text, text, text);

create function public.prepare_billing_receipt_delivery(
  p_delivery_key text,
  p_lease_token uuid,
  p_request_from text,
  p_request_subject text,
  p_request_html text,
  p_request_text text,
  p_request_reply_to text,
  p_request_tags jsonb
) returns table (
  recipient_email text,
  request_from text,
  request_subject text,
  request_html text,
  request_text text,
  request_reply_to text,
  request_tags jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if nullif(btrim(p_request_from), '') is null
     or nullif(btrim(p_request_subject), '') is null
     or nullif(btrim(p_request_html), '') is null
     or nullif(btrim(p_request_text), '') is null
     or nullif(btrim(p_request_reply_to), '') is null
     or p_request_reply_to !~* '^[^@[:space:]]+@[^@[:space:]]+$'
     or jsonb_typeof(p_request_tags) is distinct from 'array'
     or jsonb_array_length(p_request_tags) not between 1 and 5
     or exists (
       select 1
       from jsonb_array_elements(p_request_tags) tag
       where jsonb_typeof(tag) <> 'object'
          or coalesce(tag->>'name', '') not in ('category', 'flow')
          or coalesce(tag->>'value', '') !~ '^[a-z0-9_]{1,50}$'
     ) then
    raise exception 'complete, valid receipt request is required';
  end if;

  return query
  update public.cloud_billing_receipt_outbox o
  set request_from = case when o.prepared_at is null then btrim(p_request_from) else o.request_from end,
      request_subject = case when o.prepared_at is null then p_request_subject else o.request_subject end,
      request_html = case when o.prepared_at is null then p_request_html else o.request_html end,
      request_text = case when o.prepared_at is null then p_request_text else o.request_text end,
      request_reply_to = case when o.prepared_at is null then lower(btrim(p_request_reply_to)) else o.request_reply_to end,
      request_tags = case when o.prepared_at is null then p_request_tags else o.request_tags end,
      prepared_at = coalesce(o.prepared_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where o.delivery_key = p_delivery_key
    and o.lease_token = p_lease_token
    and o.sent_at is null
    and o.exhausted_at is null
  returning o.recipient_email, o.request_from, o.request_subject, o.request_html,
            o.request_text, o.request_reply_to, o.request_tags;
end
$function$;

revoke all on function public.prepare_billing_receipt_delivery(
  text, uuid, text, text, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.prepare_billing_receipt_delivery(
  text, uuid, text, text, text, text, text, jsonb
) to service_role;

