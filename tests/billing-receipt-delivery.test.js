const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260721235000_billing_receipt_delivery_outbox.sql');
const richPayloadMigration = read('supabase/migrations/20260721235100_billing_receipt_rich_payload.sql');
const privacyMigration = read('supabase/migrations/20260721235150_billing_receipt_privacy_reliability.sql');
const confirmationContextMigration = read('supabase/migrations/20260721235175_billing_payment_confirmation_context.sql');
const billing = read('supabase/functions/norva-revolut-billing/index.ts');
const docs = read('docs/BILLING-RECEIPT-DELIVERY.md');

test('captured ledger rows atomically enqueue one immutable receipt delivery', () => {
  assert.match(migration, /create table if not exists public\.cloud_billing_receipt_outbox/);
  assert.match(migration, /ledger_pi_id\s+text not null unique/);
  assert.match(migration, /references public\.cloud_billing_ledger\(pi_id\)/);
  assert.match(migration, /after insert or update of status on public\.cloud_billing_ledger/);
  assert.match(migration, /lower\(coalesce\(new\.provider, ''\)\) <> 'revolut'/);
  assert.match(migration, /lower\(coalesce\(new\.status, ''\)\) <> 'captured'/);
  assert.match(migration, /'norva-receipt-' \|\| encode\(digest\(new\.pi_id, 'sha256'\), 'hex'\)/);
  assert.match(migration, /on conflict \(ledger_pi_id\) do nothing/);
  assert.match(migration, /revoke all on table public\.cloud_billing_receipt_outbox from public, anon, authenticated/);
});

test('billing snapshots exact receipt context before the financial ledger insert', () => {
  const finalize = billing.slice(
    billing.indexOf('const finalizeCaptured'),
    billing.indexOf('const finalizeFailed'),
  );
  assert.ok(finalize.indexOf('const nextEnd = addPeriod') < finalize.indexOf('.from("cloud_billing_ledger")'));
  assert.match(finalize, /plan_code: plan/);
  assert.match(finalize, /bill_period: cadence/);
  assert.match(finalize, /billing_period_end: nextEnd/);
  assert.doesNotMatch(finalize, /sendReceipt\(/);
});

test('payment confirmation claims authoritative date, cadence and no raw provider id', () => {
  assert.match(confirmationContextMigration, /billing_period text/);
  assert.match(confirmationContextMigration, /confirmed_at timestamptz/);
  assert.match(confirmationContextMigration, /case when l\.bill_period in \('monthly', 'annual'\)/);
  assert.match(confirmationContextMigration, /c\.created_at, c\.period_end/);
  assert.match(confirmationContextMigration, /left join public\.cloud_billing_ledger l on l\.pi_id = c\.ledger_pi_id/);

  const drain = billing.slice(
    billing.indexOf('async function drainBillingReceiptOutbox'),
    billing.indexOf('// Is this the owner'),
  );
  assert.match(drain, /billingPeriod: claim\.billing_period/);
  assert.match(drain, /confirmedAt: claim\.confirmed_at/);
  assert.match(drain, /reference: `NV-\$\{claim\.delivery_key\.replace\(\/\^norva-receipt-\//);
  assert.doesNotMatch(drain, /ledger_pi_id/);
  assert.doesNotMatch(drain, /provider_payment_id/);
});

test('receipt claims use bounded leases, SKIP LOCKED and exponential retry backoff', () => {
  const claim = migration.slice(
    migration.indexOf('create or replace function public.claim_billing_receipt_deliveries'),
    migration.indexOf('create or replace function public.complete_billing_receipt_delivery'),
  );
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /set lease_token = gen_random_uuid\(\)/);
  assert.match(claim, /lease_expires_at = v_now \+ make_interval/);
  assert.match(claim, /attempt_count = o\.attempt_count \+ 1/);
  assert.match(claim, /o\.lease_expires_at is null or o\.lease_expires_at <= v_now/);

  const failure = migration.slice(
    migration.indexOf('create or replace function public.fail_billing_receipt_delivery'),
    migration.indexOf('revoke all on function public.claim_billing_receipt_deliveries'),
  );
  assert.match(failure, /not coalesce\(p_retryable, false\)/);
  assert.match(failure, /power\(2::numeric, greatest\(v_attempt - 1, 0\)\)/);
  assert.match(failure, /random\(\)/);
  assert.match(failure, /return case when v_terminal then 'dead_letter' else 'retry_scheduled' end/);
});

test('success acknowledgement requires Resend 2xx, provider id and the exact lease', () => {
  const complete = migration.slice(
    migration.indexOf('create or replace function public.complete_billing_receipt_delivery'),
    migration.indexOf('create or replace function public.fail_billing_receipt_delivery'),
  );
  assert.match(complete, /p_http_status not between 200 and 299/);
  assert.match(complete, /nullif\(btrim\(p_resend_email_id\), ''\) is null/);
  assert.match(complete, /o\.delivery_key = p_delivery_key/);
  assert.match(complete, /o\.lease_token = p_lease_token/);
  assert.match(complete, /sent_at = clock_timestamp\(\)/);
});

test('exact sender, recipient, subject and HTML are frozen before network I/O', () => {
  const prepare = migration.slice(
    migration.indexOf('create or replace function public.prepare_billing_receipt_delivery'),
    migration.indexOf('create or replace function public.complete_billing_receipt_delivery'),
  );
  assert.match(prepare, /request_from = coalesce\(o\.request_from, btrim\(p_request_from\)\)/);
  assert.match(prepare, /request_subject = coalesce\(o\.request_subject, p_request_subject\)/);
  assert.match(prepare, /request_html = coalesce\(o\.request_html, p_request_html\)/);
  assert.match(prepare, /o\.delivery_key = p_delivery_key/);
  assert.match(prepare, /o\.lease_token = p_lease_token/);

  const drain = billing.slice(
    billing.indexOf('async function drainBillingReceiptOutbox'),
    billing.indexOf('// Is this the owner'),
  );
  assert.ok(drain.indexOf('prepare_billing_receipt_delivery') < drain.indexOf('sendReceiptDelivery('));
  assert.match(drain, /prepared\.request_from/);
  assert.match(drain, /prepared\.request_subject/);
  assert.match(drain, /prepared\.request_html/);
});

test('corrective migration freezes text, support reply-to and bounded non-PII tags', () => {
  assert.match(richPayloadMigration, /add column if not exists request_text text/);
  assert.match(richPayloadMigration, /add column if not exists request_reply_to text/);
  assert.match(richPayloadMigration, /add column if not exists request_tags jsonb/);
  assert.match(richPayloadMigration, /jsonb_array_length\(request_tags\) between 1 and 5/);
  assert.match(richPayloadMigration, /coalesce\(tag->>'name', ''\) not in \('category', 'flow'\)/);
  assert.match(richPayloadMigration, /coalesce\(tag->>'value', ''\) !~ '\^\[a-z0-9_\]\{1,50\}\$'/);

  const prepare = richPayloadMigration.slice(
    richPayloadMigration.indexOf('create function public.prepare_billing_receipt_delivery'),
    richPayloadMigration.indexOf('revoke all on function public.prepare_billing_receipt_delivery'),
  );
  assert.match(prepare, /p_request_text text/);
  assert.match(prepare, /p_request_reply_to text/);
  assert.match(prepare, /p_request_tags jsonb/);
  assert.match(prepare, /request_text = case when o\.prepared_at is null then p_request_text else o\.request_text end/);
  assert.match(prepare, /request_reply_to = case when o\.prepared_at is null then lower\(btrim\(p_request_reply_to\)\) else o\.request_reply_to end/);
  assert.match(prepare, /request_tags = case when o\.prepared_at is null then p_request_tags else o\.request_tags end/);
});

test('current receipt taxonomy is exact and cross-product safe', () => {
  assert.match(privacyMigration, /jsonb_build_object\('name', 'app', 'value', 'norva'\)/);
  assert.match(privacyMigration, /jsonb_build_object\('name', 'category', 'value', 'transactional'\)/);
  assert.match(privacyMigration, /jsonb_build_object\('name', 'flow', 'value', 'payment_receipt'\)/);
  const prepare = privacyMigration.slice(
    privacyMigration.indexOf('create function public.prepare_billing_receipt_delivery'),
    privacyMigration.indexOf('revoke all on function public.prepare_billing_receipt_delivery'),
  );
  assert.match(prepare, /p_request_tags is distinct from jsonb_build_array/);
  assert.match(prepare, /request_tags = case when o\.prepared_at is null then p_request_tags else o\.request_tags end/);
});

test('Resend request checks acceptance and uses the delivery key as idempotency key', () => {
  const sender = billing.slice(
    billing.indexOf('async function sendReceiptDelivery'),
    billing.indexOf('async function drainBillingReceiptOutbox'),
  );
  assert.match(sender, /"Idempotency-Key": deliveryKey/);
  assert.match(sender, /const accepted = res\.ok && Boolean\(emailId\)/);
  assert.match(sender, /signal: AbortSignal\.timeout\(8_000\)/);
  assert.match(sender, /retryAfterSeconds: retryAfterSeconds\(res\.headers\.get\("retry-after"\)\)/);
  assert.match(sender, /request\.request_text \? \{ text: request\.request_text \}/);
  assert.match(sender, /request\.request_reply_to \? \{ reply_to: request\.request_reply_to \}/);
  assert.match(sender, /Array\.isArray\(request\.request_tags\) \? \{ tags: request\.request_tags \}/);
});

test('new receipt payload uses lifecycle text/tags and support reply-to before send', () => {
  const drain = billing.slice(
    billing.indexOf('async function drainBillingReceiptOutbox'),
    billing.indexOf('// Is this the owner'),
  );
  assert.match(billing, /const REPLY_TO = Deno\.env\.get\("NORVA_EMAIL_REPLY_TO"\) \?\? "support@norva\.tv"/);
  assert.match(drain, /p_request_text: rendered\.text/);
  assert.match(drain, /p_request_reply_to: REPLY_TO/);
  assert.match(drain, /p_request_tags: rendered\.tags/);
  assert.ok(drain.indexOf('prepare_billing_receipt_delivery') < drain.indexOf('sendReceiptDelivery('));
});

test('legacy v1 frozen payloads replay unchanged instead of mutating an idempotency key', () => {
  const prepare = richPayloadMigration.slice(
    richPayloadMigration.indexOf('create function public.prepare_billing_receipt_delivery'),
    richPayloadMigration.indexOf('revoke all on function public.prepare_billing_receipt_delivery'),
  );
  assert.match(prepare, /request_from = case when o\.prepared_at is null then btrim\(p_request_from\) else o\.request_from end/);
  assert.match(prepare, /request_text = case when o\.prepared_at is null then p_request_text else o\.request_text end/);
  const drain = billing.slice(
    billing.indexOf('async function drainBillingReceiptOutbox'),
    billing.indexOf('// Is this the owner'),
  );
  assert.match(drain, /richFieldCount !== 0 && richFieldCount !== 3/);
});

test('accepted-but-unacknowledged receipt keeps its lease for a safe replay', () => {
  const drain = billing.slice(
    billing.indexOf('async function drainBillingReceiptOutbox'),
    billing.indexOf('// Is this the owner'),
  );
  const accepted = drain.slice(drain.indexOf('if (sent.accepted'), drain.indexOf('const { data: failed'));
  assert.match(accepted, /complete_billing_receipt_delivery/);
  assert.match(accepted, /accepted_unacknowledged\+\+/);
  assert.match(accepted, /continue;/);
  assert.doesNotMatch(accepted, /fail_billing_receipt_delivery/);
});

test('billing cron drains the receipt outbox without changing charge decisions', () => {
  const run = billing.slice(billing.indexOf('async function run'), billing.indexOf('Deno.serve'));
  assert.match(run, /drainBillingReceiptOutbox\(db, errors\)/);
  assert.match(run, /receipt_delivery: receiptDelivery/);
  assert.ok(run.indexOf('reconcileOpenCheckouts(db)') < run.indexOf('drainBillingReceiptOutbox(db, errors)'));
});

test('financial evidence survives Auth deletion with stable pseudonymous correlation', () => {
  assert.match(privacyMigration, /add column if not exists user_pseudonym text/);
  assert.match(privacyMigration, /alter column user_id drop not null/);
  assert.match(privacyMigration, /foreign key \(user_id\) references auth\.users\(id\) on delete set null not valid/);
  assert.match(privacyMigration, /cloud_billing_ledger_user_pseudonym_check/);
  assert.match(privacyMigration, /before insert or update of user_id, pi_id on public\.cloud_billing_ledger/);
  assert.match(privacyMigration, /create or replace view public\.cloud_stancer_payments as\s+select \* from public\.cloud_billing_ledger/);
});

test('receipt outbox minimizes accepted mail and has bounded retention', () => {
  const complete = privacyMigration.slice(
    privacyMigration.indexOf('create or replace function public.complete_billing_receipt_delivery'),
    privacyMigration.indexOf('create or replace function public.fail_billing_receipt_delivery_v2'),
  );
  for (const field of ['recipient_email', 'first_name', 'request_subject', 'request_html', 'request_text']) {
    assert.match(complete, new RegExp(`${field} = null`));
  }
  assert.match(privacyMigration, /sent_at < now\(\) - interval '90 days'/);
  assert.match(privacyMigration, /exhausted_at < now\(\) - interval '30 days'/);
  assert.match(privacyMigration, /'norva-billing-receipt-prune'/);
});

test('provider responses and errors are allowlisted, redacted and bounded in SQL and worker', () => {
  assert.match(privacyMigration, /create or replace function public\.norva_safe_billing_receipt_provider_response/);
  assert.match(privacyMigration, /p_value->>'id'/);
  assert.match(privacyMigration, /p_value->>'message'/);
  assert.match(privacyMigration, /\[email\]/);
  assert.match(privacyMigration, /\[credential\]/);
  assert.match(privacyMigration, /norva_safe_billing_receipt_provider_response\(\s*coalesce\(p_response/);
  assert.match(privacyMigration, /norva_redact_billing_receipt_text\(\s*coalesce\(nullif\(p_error/);
  assert.match(billing, /function safeEmailProviderResponse/);
  assert.match(billing, /\.slice\(0, 16_384\)/);
  assert.match(billing, /\[email\]/);
  assert.match(billing, /\[credential\]/);
});

test('ambiguous sends replay only inside Resend idempotency window then quarantine', () => {
  const claim = privacyMigration.slice(
    privacyMigration.indexOf('create or replace function public.claim_billing_receipt_deliveries'),
    privacyMigration.indexOf('create or replace function public.complete_billing_receipt_delivery'),
  );
  assert.match(privacyMigration, /create or replace function public\.mark_billing_receipt_delivery_network_started/);
  assert.match(claim, /idempotency_started_at <= v_now - interval '23 hours'/);
  assert.match(claim, /quarantined_at = v_now/);
  assert.match(claim, /o\.lease_token is not null and o\.lease_expires_at <= v_now/);
  assert.match(claim, /o\.attempt_count < v_max_attempts or o\.delivery_uncertain/);
  assert.match(privacyMigration, /p_ambiguous boolean default false/);
  assert.match(privacyMigration, /coalesce\(v_was_uncertain, false\) or coalesce\(p_ambiguous, false\)/);
});

test('receipt worker is sequential, paced and honors provider Retry-After', () => {
  const drain = billing.slice(
    billing.indexOf('async function drainBillingReceiptOutbox'),
    billing.indexOf('// Is this the owner'),
  );
  assert.match(drain, /for \(const claim of claims\)/);
  assert.doesNotMatch(drain, /Promise\.all/);
  assert.match(drain, /setTimeout\(resolve, 250\)/);
  assert.ok(drain.indexOf('mark_billing_receipt_delivery_network_started') < drain.indexOf('sendReceiptDelivery('));
  assert.match(drain, /p_retry_after_seconds: sent\.retryAfterSeconds/);
  assert.match(drain, /p_ambiguous: sent\.ambiguous/);
});

test('Resend 409 types are not conflated', () => {
  const classify = billing.slice(
    billing.indexOf('function classifyReceiptFailure'),
    billing.indexOf('function retryAfterSeconds'),
  );
  assert.match(classify, /status === 409/);
  assert.match(classify, /name === "concurrent_idempotent_requests"/);
  assert.match(classify, /return \{ retryable: concurrent, ambiguous: concurrent \}/);
  assert.doesNotMatch(classify, /invalid_idempotent_request.*retryable:\s*true/);
});

test('operator runbook documents deletion, idempotency quarantine and retention', () => {
  assert.match(docs, /ON DELETE SET NULL/i);
  assert.match(docs, /user_pseudonym/);
  assert.match(docs, /23 heures/i);
  assert.match(docs, /quarantin/i);
  assert.match(docs, /90 jours/i);
  assert.match(docs, /30 jours/i);
  assert.match(docs, /concurrent_idempotent_requests/);
  assert.match(docs, /invalid_idempotent_request/);
});

test('recoverable Resend status classifier includes credentials, throttling and outages', () => {
  const match = billing.match(/function retryableResendStatus\(status: number \| null\): boolean \{([\s\S]*?)\n\}/);
  assert.ok(match, 'retryableResendStatus must remain extractable');
  const retryable = new Function('status', match[1]);
  for (const status of [null, 401, 403, 408, 425, 429, 500, 503]) {
    assert.equal(retryable(status), true, `${status} should retry`);
  }
  for (const status of [200, 400, 404, 409, 422]) {
    assert.equal(retryable(status), false, `${status} should not retry`);
  }
});
