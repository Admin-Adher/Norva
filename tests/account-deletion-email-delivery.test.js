const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260721235200_account_deletion_email_outbox.sql');
const hardening = read('supabase/migrations/20260721235300_account_deletion_email_delivery_hardening.sql');
const source = read('supabase/functions/norva-account-delete/index.ts');
const config = read('supabase/config.toml');
const deletePage = read('public/delete-account.html');

test('deletion outbox survives auth cascade without retaining a raw user id', () => {
  const table = migration.slice(
    migration.indexOf('create table if not exists public.cloud_account_deletion_email_outbox'),
    migration.indexOf('create index if not exists cloud_account_deletion_email_due_idx'),
  );
  assert.match(table, /account_key\s+text primary key/);
  assert.match(table, /delivery_key\s+text not null unique/);
  assert.doesNotMatch(table, /references auth\.users/i);
  assert.doesNotMatch(table, /user_id\s+uuid/i);
  assert.match(migration, /encode\(digest\(p_user_id::text, 'sha256'\), 'hex'\)/);
  assert.match(migration, /revoke all on table public\.cloud_account_deletion_email_outbox from public, anon, authenticated/);
});

test('a prepared confirmation becomes deliverable only with the real auth deletion', () => {
  const prepare = migration.slice(
    migration.indexOf('create or replace function public.prepare_account_deletion_email'),
    migration.indexOf('create or replace function public.cancel_prepared_account_deletion_email'),
  );
  assert.match(prepare, /where u\.id = p_user_id and lower\(btrim\(u\.email\)\) = v_email/);
  assert.match(prepare, /'prepared'/);
  assert.match(prepare, /interval '30 minutes'/);

  const activation = migration.slice(
    migration.indexOf('create or replace function public.norva_activate_account_deletion_email'),
    migration.indexOf('drop trigger if exists norva_activate_account_deletion_email_trg'),
  );
  assert.match(activation, /encode\(digest\(old\.id::text, 'sha256'\), 'hex'\)/);
  assert.match(activation, /set state = 'ready'/);
  assert.match(activation, /o\.prepare_expires_at > clock_timestamp\(\)/);
  assert.match(activation, /exception when others then[\s\S]*raise warning/);
  assert.match(migration, /after delete on auth\.users/);
});

test('Edge freezes the exact request before deletion and activates it only after success', () => {
  const prepare = source.indexOf('prepare_account_deletion_email');
  const deletion = source.indexOf('admin.auth.admin.deleteUser(user.id)');
  const confirm = source.indexOf('confirm_account_deletion_email');
  assert.ok(prepare >= 0 && prepare < deletion && deletion < confirm);
  assert.match(source, /p_request_html: rendered\.html/);
  assert.match(source, /p_request_text: rendered\.text/);
  assert.match(source, /p_request_tags: rendered\.tags/);
  assert.match(source, /p_request_reply_to: REPLY_TO/);
  assert.match(source, /cancel_prepared_account_deletion_email/);
  assert.match(source, /p_deleted_user_id: user\.id/);
  assert.doesNotMatch(source, /email is best-effort|Best-effort closure email/);
});

test('the Edge fallback independently proves the exact auth identity is gone', () => {
  const confirm = migration.slice(
    migration.indexOf('create or replace function public.confirm_account_deletion_email'),
    migration.indexOf('create or replace function public.claim_account_deletion_email_deliveries'),
  );
  assert.match(confirm, /p_deleted_user_id uuid/);
  assert.match(confirm, /encode\(digest\(p_deleted_user_id::text, 'sha256'\), 'hex'\)/);
  assert.match(confirm, /o\.account_key = v_account_key/);
  assert.match(confirm, /not exists \(select 1 from auth\.users u where u\.id = p_deleted_user_id\)/);
  assert.match(migration, /revoke all on function public\.confirm_account_deletion_email\(text, uuid\)/);
});

test('account deletion remains primary and public response contains no deleted identifier', () => {
  assert.match(source, /confirmation preparation unavailable/);
  assert.ok(source.indexOf('confirmation preparation unavailable') < source.indexOf('admin.auth.admin.deleteUser(user.id)'));
  assert.match(source, /return json\(req, \{ ok: true, deleted: true, emailConfirmation: confirmation \}\)/);
  const success = source.slice(source.lastIndexOf('// No deleted UUID/email'), source.length);
  assert.doesNotMatch(success, /userId|user\.id|email[,}]/);
  assert.match(source, /return json\(req, \{ error: "Deletion failed" \}, 500\)/);
  assert.doesNotMatch(source, /details: delErr\.message/);
});

test('account deletion requires fresh interactive auth and the session MFA level', () => {
  const guard = source.slice(
    source.indexOf('async function deletionAuthenticationGuard'),
    source.indexOf('async function sendDeletionEmail'),
  );
  assert.match(guard, /getAuthenticatorAssuranceLevel\(token\)/);
  assert.match(guard, /data\.nextLevel === "aal2" && data\.currentLevel !== "aal2"/);
  assert.match(guard, /method !== "token_refresh" && method !== "anonymous"/);
  assert.match(guard, /RECENT_AUTH_MAX_AGE_SECONDS/);
  assert.match(source, /const RECENT_AUTH_MAX_AGE_SECONDS = 15 \* 60/);
  assert.match(source, /code: "reauthentication_required"/);
  assert.match(source, /code: "mfa_verification_required"/);
  assert.ok(source.indexOf('deletionAuthenticationGuard(token)') < source.indexOf('admin.auth.admin.deleteUser(user.id)'));
  assert.match(deletePage, /code === 'reauthentication_required'/);
  assert.match(deletePage, /returnTo=' \+ encodeURIComponent\('\/delete-account\.html'\)/);
});

test('Resend transport is bounded, idempotent and acknowledges only 2xx plus id', () => {
  const sender = source.slice(
    source.indexOf('async function sendDeletionEmail'),
    source.indexOf('async function drainDeletionEmailOutbox'),
  );
  assert.match(sender, /"Idempotency-Key": claim\.delivery_key/);
  assert.match(sender, /reply_to: claim\.request_reply_to/);
  assert.match(sender, /text: claim\.request_text/);
  assert.match(sender, /tags: claim\.request_tags/);
  assert.match(sender, /accepted: res\.ok && Boolean\(emailId\)/);
  assert.match(sender, /AbortSignal\.timeout\(8_000\)/);

  const complete = migration.slice(
    migration.indexOf('create or replace function public.complete_account_deletion_email_delivery'),
    migration.indexOf('create or replace function public.fail_account_deletion_email_delivery'),
  );
  assert.match(complete, /p_http_status not between 200 and 299/);
  assert.match(complete, /nullif\(btrim\(p_resend_email_id\), ''\) is null/);
  assert.match(complete, /o\.lease_token = p_lease_token/);
});

test('success immediately erases recipient and rendered bodies from the outbox', () => {
  const complete = migration.slice(
    migration.indexOf('create or replace function public.complete_account_deletion_email_delivery'),
    migration.indexOf('create or replace function public.fail_account_deletion_email_delivery'),
  );
  assert.match(complete, /recipient_email = null/);
  assert.match(complete, /request_html = null/);
  assert.match(complete, /request_text = null/);
  assert.match(migration, /state = 'sent' and recipient_email is null and request_html is null and request_text is null/);
  assert.match(migration, /state = 'dead_letter'[\s\S]*interval '30 days'/);
});

test('claims are leased and failed sends use bounded retry or dead-letter', () => {
  const claim = migration.slice(
    migration.indexOf('create or replace function public.claim_account_deletion_email_deliveries'),
    migration.indexOf('create or replace function public.complete_account_deletion_email_delivery'),
  );
  assert.match(claim, /o\.deletion_confirmed_at is not null/);
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /lease_token = gen_random_uuid\(\)/);
  assert.match(claim, /o\.state = 'processing' and o\.lease_expires_at <= v_now/);

  const failure = migration.slice(
    migration.indexOf('create or replace function public.fail_account_deletion_email_delivery'),
    migration.indexOf('create or replace function public.prune_account_deletion_email_outbox'),
  );
  assert.match(failure, /power\(2::numeric, greatest\(v_attempt - 1, 0\)\)/);
  assert.match(failure, /random\(\)/);
  assert.match(failure, /case when v_terminal then 'dead_letter' else 'ready' end/);
});

test('accepted but unacknowledged sends keep the lease for safe replay', () => {
  const drain = source.slice(
    source.indexOf('async function drainDeletionEmailOutbox'),
    source.indexOf('async function cronAuthorized'),
  );
  const accepted = drain.slice(drain.indexOf('if (sent.accepted'), drain.indexOf('const { data: failed'));
  assert.match(accepted, /complete_account_deletion_email_delivery/);
  assert.match(accepted, /accepted_unacknowledged\+\+/);
  assert.match(accepted, /continue;/);
  assert.doesNotMatch(accepted, /fail_account_deletion_email_delivery/);
});

test('worker stays below the shared Resend limit and propagates a team 429', () => {
  const drain = source.slice(
    source.indexOf('async function drainDeletionEmailOutbox'),
    source.indexOf('async function cronAuthorized'),
  );
  assert.match(source, /const DELIVERY_SPACING_MS = 250/);
  assert.match(drain, /for \(const claim of claims\)/);
  assert.match(drain, /await sleep\(DELIVERY_SPACING_MS\)/);
  assert.doesNotMatch(drain, /Promise\.all/);
  assert.match(drain, /sent\.status === 429/);
  assert.match(drain, /sent\.retryAfterSeconds \?\? 60/);
  assert.match(drain, /resend_team_rate_limited_before_send/);
});

test('ambiguous provider outcomes are quarantined before idempotency expires', () => {
  assert.match(hardening, /transport_started_at timestamptz/);
  assert.match(hardening, /interval '23 hours'/);
  assert.match(hardening, /idempotency_window_expired_manual_review/);
  assert.match(hardening, /transport_started_at = coalesce\(o\.transport_started_at, v_now\)/);
  assert.match(hardening, /v_idempotency_window_terminal/);
  assert.doesNotMatch(hardening, /interval '24 hours'/);
});

test('dedicated cron is self-authenticated and managed gateway verification is disabled', () => {
  assert.match(source, /pathname\.endsWith\("\/cron\/run"\)/);
  assert.match(source, /norva_verify_cron_secret/);
  assert.match(migration, /'norva-account-deletion-email'/);
  assert.match(migration, /norva-account-delete\/cron\/run/);
  assert.match(migration, /where exists \([\s\S]*cloud_account_deletion_email_outbox/);
  assert.match(config, /\[functions\.norva-account-delete\]\s*\nverify_jwt = false/);
});

test('confirmation email is accessible multipart content with stable non-PII tags', () => {
  const template = source.slice(
    source.indexOf('function renderAccountDeleted'),
    source.indexOf('interface DeletionDeliveryClaim'),
  );
  assert.match(template, /<html lang="en" dir="ltr">/);
  assert.match(template, /data-preheader="true"/);
  assert.match(template, /support@norva\.tv/);
  assert.match(template, /https:\/\/norva\.tv\/privacy\.html/);
  assert.match(template, /text:/);
  assert.match(template, /name: "app", value: "norva"/);
  assert.match(template, /value: "transactional_auth"/);
  assert.match(template, /value: "account_deleted"/);
  assert.doesNotMatch(template, /all associated data have been permanently removed/i);
  assert.doesNotMatch(template, /user\.id|recipient_email|user@email/);
});

test('Resend diagnostics are allow-listed and redact addresses, URLs and secrets', () => {
  const sender = source.slice(
    source.indexOf('function redactDiagnosticText'),
    source.indexOf('async function deletionAuthenticationGuard'),
  ) + source.slice(
    source.indexOf('async function sendDeletionEmail'),
    source.indexOf('async function drainDeletionEmailOutbox'),
  );
  assert.match(sender, /\[redacted-email\]/);
  assert.match(sender, /\[redacted-url\]/);
  assert.match(sender, /\[redacted-secret\]/);
  assert.match(sender, /safeResendResponse\(payload, emailId\)/);
  assert.match(sender, /if \(emailId\) return \{ id: emailId \}/);
  assert.match(sender, /payload\[key\] \?\? nestedError\?\.\[key\]/);
  assert.doesNotMatch(sender, /response: payload/);
});

test('recoverable Resend classifier distinguishes concurrent 409 from invalid idempotency reuse', () => {
  const helperMatch = source.match(/function resendErrorName\(payload: JsonRecord\): string \{([\s\S]*?)\n\}/);
  const match = source.match(/function retryableResendStatus\(status: number \| null, payload: JsonRecord = \{\}\): boolean \{([\s\S]*?)\n\}/);
  assert.ok(helperMatch);
  assert.ok(match);
  const resendErrorName = new Function('payload', helperMatch[1].replace(/ as JsonRecord/g, ''));
  const retryable = new Function('status', 'payload', 'resendErrorName', match[1]);
  for (const status of [null, 401, 403, 408, 425, 429, 500, 503]) {
    assert.equal(retryable(status, {}, resendErrorName), true, `${status} should retry`);
  }
  for (const status of [200, 400, 404, 422]) {
    assert.equal(retryable(status, {}, resendErrorName), false, `${status} should not retry`);
  }
  assert.equal(retryable(409, { name: 'concurrent_idempotent_requests' }, resendErrorName), true);
  assert.equal(retryable(409, { error: { type: 'concurrent_idempotent_requests' } }, resendErrorName), true);
  assert.equal(retryable(409, { name: 'idempotency_key_conflict' }, resendErrorName), false);
});
