-- Close the reviewed-access loop with one durable transactional email.
--
-- The trigger is deliberately bound to the only valid state transition. A
-- replay of an already-decided Admin command therefore cannot enqueue another
-- message, even after the delivery outbox has reached its retention limit.

create or replace function affiliate_private.partners_access_decision_email_enqueue()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient_email text;
  v_subject text;
  v_heading text;
  v_intro text;
  v_footer text;
  v_flow text;
  v_dedupe_key text := 'partners_access_decision:' || new.id::text;
  v_notification_id uuid;
begin
  select lower(btrim(account_user.email))
  into v_recipient_email
  from auth.users account_user
  where account_user.id = new.user_id
    and account_user.email_confirmed_at is not null
    and nullif(btrim(account_user.email), '') is not null
  for share;

  if v_recipient_email is null then
    raise exception 'confirmed recipient email unavailable'
      using errcode = 'P0001';
  end if;

  if new.status = 'approved' then
    v_subject := 'Your Norva Partners access is approved';
    v_heading := 'Welcome to Norva Partners';
    v_intro := 'Your early-access request has been approved. Open Norva Partners to review the current programme conditions. Approval does not create a partner account, start identity verification or enable payouts; those steps become available only when your pilot cohort opens.';
    v_footer := 'Norva never asks you to pay to join Partners. If you did not request access, contact support@norva.tv.';
    v_flow := 'partners_access_approved';
  elsif new.status = 'declined' then
    v_subject := 'Update on your Norva Partners request';
    v_heading := 'Your Partners request was reviewed';
    v_intro := 'We cannot approve your current request. No partner account, identity verification or financial profile was created. This decision does not affect your Norva subscription or access to the player.';
    v_footer := 'You can review programme availability in Norva or contact support@norva.tv if you believe this decision is incorrect.';
    v_flow := 'partners_access_declined';
  else
    raise exception 'invalid Partners access decision transition'
      using errcode = '23514';
  end if;

  v_notification_id := public.norva_enqueue_branded_email(
    v_recipient_email,
    v_subject,
    v_heading,
    v_intro,
    'Open Norva Partners',
    'https://norva.tv/app#partners',
    v_footer,
    v_flow,
    v_dedupe_key,
    new.user_id
  );

  -- A partial unique-key conflict must never be mistaken for this user's
  -- notification. Validate the immutable request while it is still pending.
  if not exists (
    select 1
    from public.cloud_branded_email_outbox outbox_row
    where outbox_row.id = v_notification_id
      and outbox_row.dedupe_key = v_dedupe_key
      and outbox_row.user_id = new.user_id
      and outbox_row.flow = v_flow
      and outbox_row.delivery_key = 'norva-branded-' || v_notification_id::text
      and not outbox_row.is_marketing
      and outbox_row.request_from = 'Norva <support@norva.tv>'
      and outbox_row.recipient_email = v_recipient_email
      and outbox_row.request_reply_to = 'support@norva.tv'
      and outbox_row.request_subject = v_subject
      and outbox_row.request_html = public.norva_branded_email_html(
        v_heading,
        v_intro,
        'Open Norva Partners',
        'https://norva.tv/app#partners',
        v_footer
      )
      and outbox_row.request_text = public.norva_branded_email_text(
        v_heading,
        v_intro,
        'Open Norva Partners',
        'https://norva.tv/app#partners',
        v_footer
      )
      and outbox_row.request_tags = jsonb_build_array(
        jsonb_build_object('name', 'app', 'value', 'norva'),
        jsonb_build_object('name', 'category', 'value', 'transactional'),
        jsonb_build_object('name', 'flow', 'value', v_flow)
      )
      and outbox_row.request_headers = '{}'::jsonb
      and outbox_row.state = 'pending'
      and outbox_row.attempt_count = 0
      and outbox_row.next_attempt_at <= clock_timestamp()
      and outbox_row.marker_kind is null
      and outbox_row.marker_reference is null
      and outbox_row.marker_stage is null
      and outbox_row.last_attempt_at is null
      and outbox_row.lease_token is null
      and outbox_row.lease_expires_at is null
      and outbox_row.resend_email_id is null
      and outbox_row.resend_response is null
      and outbox_row.last_http_status is null
      and outbox_row.last_error is null
      and outbox_row.sent_at is null
      and outbox_row.dead_lettered_at is null
      and outbox_row.transport_started_at is null
      and outbox_row.payload_scrubbed_at is null
  ) then
    raise exception 'Partners access decision email mismatch'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function
  affiliate_private.partners_access_decision_email_enqueue()
from public, anon, authenticated, service_role;

drop trigger if exists partners_access_decision_email_enqueue
  on affiliate_private.affiliate_access_requests;
create trigger partners_access_decision_email_enqueue
after update of status on affiliate_private.affiliate_access_requests
for each row
when (
  old.status = 'requested'
  and new.status in ('approved', 'declined')
)
execute function affiliate_private.partners_access_decision_email_enqueue();

comment on function affiliate_private.partners_access_decision_email_enqueue() is
  'Atomically freezes one verified, deduplicated user email for a requested-to-final Partners access decision.';
