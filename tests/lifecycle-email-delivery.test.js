const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260722003000_lifecycle_email_delivery_outbox.sql');
const billingIntents = read('supabase/migrations/20260722003500_lifecycle_billing_event_intents.sql');
const paymentTerminal = read('supabase/migrations/20260722121000_payment_terminal_reconciliation.sql');
const lifecycle = read('supabase/functions/norva-lifecycle/index.ts');
const worker = read('supabase/functions/norva-branded-email-worker/index.ts');
const templates = read('supabase/functions/_shared/lifecycle-email.ts');
const revolut = read('supabase/functions/norva-revolut/index.ts');
const revolutBilling = read('supabase/functions/norva-revolut-billing/index.ts');
const billingWebhook = read('supabase/functions/norva-billing-webhook/index.ts');
const admin = read('supabase/functions/norva-admin/index.ts');
const docs = read('docs/LIFECYCLE-EMAIL-DELIVERY.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test('lifecycle producer freezes exact payloads and never calls Resend directly', () => {
  assert.match(lifecycle, /db\.rpc\("norva_enqueue_lifecycle_email"/);
  assert.match(lifecycle, /p_request_html: rendered\.html/);
  assert.match(lifecycle, /p_request_text: rendered\.text/);
  assert.match(lifecycle, /p_request_headers: unsubscribeHeaders/);
  assert.doesNotMatch(lifecycle, /api\.resend\.com\/emails|Authorization: `Bearer \$\{RESEND_API_KEY\}`/);
  for (const marker of ['welcome', 'dunning', 'winback', 'abandoned']) {
    assert.match(lifecycle, new RegExp(`markerKind: "${marker}"`));
  }
});

test('enqueue is semantic-key idempotent and validates recipient, tags and consent', () => {
  const enqueue = section(migration,
    'create or replace function public.norva_enqueue_lifecycle_email(',
    '-- Final eligibility/consent gate');
  assert.match(enqueue, /from auth\.users u where u\.id = p_user_id/);
  assert.match(enqueue, /v_email <> v_auth_email/);
  assert.match(enqueue, /admin_internal_accounts/);
  assert.match(enqueue, /norva_marketing_email_allowed\(p_user_id\)/);
  assert.match(enqueue, /List-Unsubscribe-Post/);
  assert.match(enqueue, /on conflict \(dedupe_key\) where dedupe_key is not null do nothing/);
  assert.match(enqueue, /lifecycle_dedupe_key_conflict/);
  assert.match(migration, /request_headers jsonb/);
  assert.match(migration, /is_marketing boolean/);
});

test('marketing consent and source relevance are checked immediately before send', () => {
  const authorize = section(migration,
    'create or replace function public.authorize_branded_email_delivery(',
    'drop function if exists public.claim_branded_email_deliveries');
  assert.match(authorize, /state = 'processing'.*lease_token = p_lease_token/s);
  assert.match(authorize, /o\.is_marketing and not public\.norva_marketing_email_allowed\(o\.user_id\)/);
  assert.match(authorize, /e\.status = 'past_due'/);
  assert.match(authorize, /r\.reminder_sent_at is null/);
  assert.match(authorize, /state = 'canceled'/);
  assert.match(authorize, /transport_started_at = coalesce\(x\.transport_started_at, clock_timestamp\(\)\)/);
  const call = worker.indexOf('authorize_branded_email_delivery');
  const send = worker.indexOf('const sent = await sendDelivery(claim)', call);
  assert.ok(call > 0 && send > call);
});

test('lifecycle claim RPC replaces its expanded table return type with service-only permissions', () => {
  const drop = migration.indexOf(
    'drop function if exists public.claim_branded_email_deliveries(integer, integer, integer)',
  );
  const create = migration.indexOf('create function public.claim_branded_email_deliveries(', drop);
  assert.ok(drop >= 0 && create > drop);
  assert.match(migration, /revoke all on function[\s\S]*public\.claim_branded_email_deliveries\(integer,integer,integer\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*public\.claim_branded_email_deliveries\(integer,integer,integer\)[\s\S]*to service_role/);
});

test('business markers and trial J-3/J-1 delivery finalize only after provider ack', () => {
  const complete = section(migration,
    'create or replace function public.complete_branded_email_delivery(',
    'create or replace function public.fail_branded_email_delivery');
  assert.match(complete, /p_http_status not between 200 and 299/);
  assert.match(complete, /nullif\(btrim\(p_resend_email_id\),''\) is null/);
  assert.match(complete, /set state='sent'/);
  for (const marker of ['welcome_email_at', 'dunning_stage', 'dunning_last_at', 'winback_email_at', 'reminder_sent_at']) {
    assert.match(complete, new RegExp(marker));
  }
  assert.match(complete, /cloud_trial_reminder_deliveries d[\s\S]*delivered_at/);
  assert.match(complete, /trial_reminder_email_at/);

  const trial = section(migration,
    'create or replace function public.norva_send_trial_ending_reminders(',
    "notify pgrst, 'reload schema'");
  assert.match(trial, /p_days_before not in \(1,3\)/);
  assert.match(trial, /email_delivery_id=v_delivery/);
  assert.doesNotMatch(trial, /set trial_reminder_email_at/);
  assert.doesNotMatch(trial, /set delivered_at/);
});

test('worker has typed 409 handling, sequential shared throttling and 429 deferral', () => {
  assert.match(worker, /status === 409/);
  assert.match(worker, /name === "concurrent_idempotent_requests"/);
  assert.match(worker, /name === "invalid_idempotent_request"/);
  assert.match(worker, /concurrent\|in\.\?progress\|already processing/);
  assert.match(worker, /invalid\|mismatch\|different payload\|expired/);
  assert.doesNotMatch(worker, /Promise\.all\(claims\.map/);
  assert.match(worker, /setTimeout\(resolve, 300\)/);
  assert.match(worker, /sent\.status === 429/);
  assert.match(worker, /defer_branded_email_delivery/);
  assert.match(worker, /headers: claim\.request_headers/);
});

test('retries stop inside the 24h key window and privacy retention is bounded', () => {
  assert.match(migration, /transport_started_at/);
  assert.match(migration, /interval '23 hours'/);
  assert.match(migration, /ambiguous_delivery_after_idempotency_window/);
  assert.match(migration, /p_ambiguous boolean default false/);
  assert.match(migration, /v_window_terminal := coalesce\(p_ambiguous,false\)/);
  assert.match(migration, /not coalesce\(p_ambiguous,false\) then null/);
  assert.match(worker, /ambiguousResendStatus/);
  assert.match(migration, /state='dead_letter'/);
  assert.match(migration, /interval '14 days'/);
  assert.match(migration, /interval '90 days'/);
  assert.match(migration, /recipient_email=null, request_reply_to=null, request_subject=null/);
  assert.match(worker, /safeProviderResponse/);
  assert.match(worker, /redactProviderText/);
});

test('billing events use an immutable journal bridge and every supported producer is attached', () => {
  assert.match(migration, /billing_event/);
  for (const flow of [
    'cancellation confirmed', 'subscription resumed', 'plan change scheduled',
    'plan change applied', 'payment recovered', 'access expired', 'refund confirmed',
  ]) assert.match(docs, new RegExp(flow, 'i'));
  assert.match(billingIntents, /create table if not exists public\.cloud_lifecycle_billing_intents/);
  assert.match(billingIntents, /after insert on public\.cloud_entitlement_events/);
  assert.match(billingIntents, /norva_apply_revolut_account_action/);
  assert.match(billingIntents, /update public\.cloud_entitlement_projection[\s\S]*insert into public\.cloud_entitlement_events/);
  assert.match(billingIntents, /on delete cascade/);
  assert.match(billingIntents, /payload='\{\}'::jsonb,payload_scrubbed_at=clock_timestamp\(\)/);
  assert.match(lifecycle, /runBillingEventIntents/);
  assert.match(lifecycle, /claim_lifecycle_billing_intents/);
  assert.match(lifecycle, /intentIso/);
  assert.match(revolut, /p_action: "cancel"/);
  assert.match(revolut, /p_action: "resume"/);
  assert.match(revolut, /"PLAN_CHANGE_SCHEDULED"/);
  assert.match(revolutBilling, /"PAYMENT_RECOVERED"/);
  assert.match(revolutBilling, /"PLAN_CHANGE_APPLIED"/);
  assert.match(revolutBilling, /"ACCESS_EXPIRED"/);
  assert.match(admin, /complete_revolut_full_refund/);
  assert.match(paymentTerminal, /'REFUND_CONFIRMED'/);
  assert.match(billingWebhook, /previous_status: existingProjection\?\.status/);
  for (const renderer of [
    'renderCancellationConfirmed', 'renderSubscriptionResumed',
    'renderPlanChangeScheduled', 'renderPlanChangeApplied',
    'renderPaymentRecovered', 'renderAccessExpired', 'renderRefundConfirmed',
  ]) assert.match(templates, new RegExp(`export function ${renderer}`));
  for (const flow of [
    'cancellation_confirmed', 'subscription_resumed', 'plan_change_scheduled',
    'plan_change_applied', 'payment_recovered', 'access_expired', 'refund_confirmed',
  ]) assert.match(templates, new RegExp(`flow: "${flow}"`));
});
