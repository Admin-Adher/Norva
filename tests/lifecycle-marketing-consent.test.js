const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260721112000_lifecycle_marketing_consent.sql'),
  'utf8',
);
const lifecycle = fs.readFileSync(
  path.join(root, 'supabase/functions/norva-lifecycle/index.ts'),
  'utf8',
);
const deliveryMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260722003000_lifecycle_email_delivery_outbox.sql'),
  'utf8',
);
const emailWorker = fs.readFileSync(
  path.join(root, 'supabase/functions/norva-branded-email-worker/index.ts'),
  'utf8',
);
const templates = fs.readFileSync(
  path.join(root, 'supabase/functions/_shared/lifecycle-email.ts'),
  'utf8',
);
const audienceHelperPath = path.join(root, 'supabase/functions/_shared/resend-audience.mjs');
const audienceHelper = fs.readFileSync(audienceHelperPath, 'utf8');
const compose = fs.readFileSync(path.join(root, 'ops/hetzner/docker-compose.supabase.yml'), 'utf8');
const envExample = fs.readFileSync(path.join(root, 'ops/hetzner/.env.hetzner.example'), 'utf8');

test('lifecycle transport is bounded, provider-acknowledged and idempotent for transactional flows', () => {
  assert.match(lifecycle, /norva_enqueue_lifecycle_email/);
  assert.match(lifecycle, /dedupeKey: `lifecycle:welcome:\$\{row\.user_id\}`/);
  assert.match(lifecycle, /dedupeKey: `lifecycle:dunning:\$\{row\.user_id\}:\$\{stage\}`/);
  assert.doesNotMatch(lifecycle, /api\.resend\.com\/emails/);
  assert.match(emailWorker, /signal: AbortSignal\.timeout\(8_000\)/);
  assert.match(emailWorker, /accepted: res\.ok && Boolean\(emailId\)/);
  assert.match(deliveryMigration, /set state='sent'/);
});

test('marketing email consent is explicit and defaults off', () => {
  assert.match(migration, /create table if not exists public\.cloud_marketing_email_preferences/i);
  assert.match(migration, /marketing_email_opt_in boolean not null default false/i);
  assert.match(migration, /cloud_marketing_email_preferences_explicit_opt_in/i);
  assert.match(migration, /opted_in_at is not null/i);
  assert.match(migration, /opted_in_source/i);
  assert.match(migration, /unsubscribed_at is null/i);
  assert.match(migration, /unsubscribed_source text/i);
  assert.match(migration, /insert into public\.cloud_marketing_email_preferences \(user_id\)/i);
});

test('signup and durable Resend reconciliation never imply consent', () => {
  const signup = migration.slice(
    migration.indexOf('create or replace function public.norva_sync_signup_to_resend'),
    migration.indexOf('-- Backfill is reconciliation'),
  );
  assert.match(signup, /insert into public\.cloud_marketing_email_preferences/i);
  assert.match(signup, /exception when others/i);
  assert.match(signup, /return new/i);
  assert.doesNotMatch(signup, /'unsubscribed'\s*,\s*false/i);

  const sync = migration.slice(
    migration.indexOf('create or replace function public.norva_enqueue_marketing_preference_to_resend'),
    migration.indexOf('-- Replace the legacy signup network trigger'),
  );
  assert.match(sync, /norva_enqueue_resend_audience_contact/i);
  assert.match(sync, /not v_effective_opt_in/i);
  assert.match(sync, /marketing_email_opt_in is true/i);
  assert.match(sync, /opted_in_at is not null/i);
  assert.match(sync, /unsubscribed_at is null/i);

  const backfill = migration.slice(migration.indexOf('-- Backfill is reconciliation'));
  assert.match(backfill, /not coalesce\(v_effective_opt_in, false\)/i);
  assert.doesNotMatch(backfill, /'unsubscribed'\s*,\s*false/i);
  assert.doesNotMatch(migration, /net\.http_post/i);
});

test('Resend audience outbox is service-only, revisioned, leased and retryable', () => {
  assert.match(migration, /create table if not exists public\.cloud_resend_audience_outbox/i);
  assert.match(migration, /desired_unsubscribed boolean not null/i);
  assert.match(migration, /revision bigint not null default 1/i);
  assert.match(migration, /synced_revision bigint/i);
  assert.match(migration, /last_http_status integer/i);
  assert.match(migration, /last_result jsonb/i);
  assert.match(migration, /last_error text/i);
  assert.match(migration, /synced_at timestamptz/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.cloud_resend_audience_outbox from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.cloud_resend_audience_outbox to service_role/i);

  const claim = migration.slice(
    migration.indexOf('create or replace function public.claim_resend_audience_outbox'),
    migration.indexOf('create or replace function public.complete_resend_audience_outbox'),
  );
  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /lease_token = gen_random_uuid\(\)/i);
  assert.match(claim, /attempt_count = o\.attempt_count \+ 1/i);

  const complete = migration.slice(
    migration.indexOf('create or replace function public.complete_resend_audience_outbox'),
    migration.indexOf('create or replace function public.fail_resend_audience_outbox'),
  );
  assert.match(complete, /o\.revision = p_revision/i);
  assert.match(complete, /o\.lease_token = p_lease_token/i);
  assert.match(complete, /p_http_status between 200 and 299/i);
  assert.match(complete, /synced_revision = p_revision/i);
  assert.match(complete, /synced_at = clock_timestamp\(\)/i);

  const failure = migration.slice(
    migration.indexOf('create or replace function public.fail_resend_audience_outbox'),
    migration.indexOf('-- Backfill is reconciliation'),
  );
  assert.match(failure, /power\(2::numeric/i);
  assert.match(failure, /next_attempt_at = clock_timestamp\(\) \+ make_interval/i);
  assert.match(failure, /last_error =/i);
});

test('auth email changes and deletion always enqueue the old address unsubscribed', () => {
  const authSync = migration.slice(
    migration.indexOf('create or replace function public.norva_enqueue_auth_email_change_to_resend'),
    migration.indexOf('-- Concurrent cron workers claim distinct rows'),
  );
  assert.match(authSync, /if tg_op = 'DELETE'/i);
  assert.match(authSync, /old\.email, true/i);
  assert.match(authSync, /old\.email is distinct from new\.email/i);
  assert.match(authSync, /new\.email, not coalesce\(v_effective_opt_in, false\)/i);
  assert.match(authSync, /after update of email, raw_user_meta_data on auth\.users/i);
  assert.match(authSync, /after delete on auth\.users/i);
});

test('Resend transport PATCHes, creates on 404, and PATCHes after a create conflict', async () => {
  assert.match(audienceHelper, /method: "PATCH"|request\("PATCH"/);
  assert.match(audienceHelper, /request\("POST"/);
  assert.match(audienceHelper, /firstPatch\.status !== 404/);
  assert.match(audienceHelper, /isCreateConflict/);

  const { syncResendAudienceContact } = await import(pathToFileURL(audienceHelperPath).href);
  const calls = [];
  const responses = [
    new Response('{"message":"missing"}', { status: 404 }),
    new Response('{"name":"duplicate_contact","message":"contact already exists"}', { status: 409 }),
    new Response('{"id":"contact-1"}', { status: 200 }),
  ];
  const result = await syncResendAudienceContact({
    apiKey: 'test-key',
    audienceId: 'audience-id',
    email: 'person@example.com',
    unsubscribed: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return responses.shift();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.operation, 'patch_after_create_conflict');
  assert.deepEqual(calls.map((c) => c.method), ['PATCH', 'POST', 'PATCH']);
  assert.match(calls[0].url, /audiences\/audience-id\/contacts\/person%40example\.com$/);
  assert.deepEqual(calls[0].body, { unsubscribed: true });
  assert.deepEqual(calls[1].body, { email: 'person@example.com', unsubscribed: true });
});

test('Resend transport failures are returned for durable retry, never reported as success', async () => {
  const { syncResendAudienceContact } = await import(pathToFileURL(audienceHelperPath).href);
  const result = await syncResendAudienceContact({
    apiKey: 'test-key',
    audienceId: 'audience-id',
    email: 'person@example.com',
    unsubscribed: false,
    fetchImpl: async () => new Response('{"message":"temporarily unavailable"}', { status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  assert.match(result.error, /temporarily unavailable/);
});

test('all marketing eligibility excludes internal accounts and abandoned checkout claims require consent', () => {
  assert.match(migration, /create or replace function public\.norva_marketing_email_allowed/i);
  assert.match(migration, /admin_internal_accounts/i);
  const abandoned = migration.slice(migration.indexOf('create or replace function public.claim_revolut_abandoned_orders'));
  assert.match(abandoned, /norva_marketing_email_allowed\(l\.user_id\)/i);
  assert.match(abandoned, /admin_internal_accounts/i);
});

test('lifecycle exposes signed idempotent RFC8058 unsubscribe and authenticated preferences', () => {
  assert.match(lifecycle, /SUPABASE_PUBLIC_URL/);
  assert.match(lifecycle, /PUBLIC_FUNCTIONS_URL/);
  assert.match(lifecycle, /\^https:\\\/\\\//);
  assert.doesNotMatch(lifecycle, /UNSUBSCRIBE_URL = `\$\{SUPABASE_URL\}/);
  assert.match(lifecycle, /NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET/);
  assert.match(lifecycle, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(lifecycle, /crypto\.subtle\.verify/);
  assert.match(lifecycle, /List-Unsubscribe-Post/);
  assert.match(lifecycle, /List-Unsubscribe=One-Click/);
  assert.match(lifecycle, /url\.pathname\.endsWith\("\/unsubscribe"\)/);
  assert.match(lifecycle, /url\.pathname\.endsWith\("\/preferences"\)/);
  assert.match(lifecycle, /if \(req\.method === "GET"\) return unsubscribeHtml\(token, false\)/);
  assert.match(lifecycle, /current\?\.marketing_email_opt_in === false && current\.unsubscribed_at/);
  assert.match(lifecycle, /authenticatedUserId/);
  assert.match(lifecycle, /Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info"/);
});

test('contact projection is retired from public lifecycle and owned by the private ops worker', () => {
  const worker = fs.readFileSync(path.join(root, 'ops/hetzner/scripts/resend-contact-worker.mjs'), 'utf8');
  assert.doesNotMatch(lifecycle, /claim_resend_audience_outbox|syncResendContactProjection|RESEND_MANAGEMENT_API_KEY/);
  assert.match(lifecycle, /url\.pathname\.endsWith\("\/cron\/resend-contacts"\)/);
  assert.match(lifecycle, /return json\(\{ error: "Not found" \}, 404\)/);
  assert.match(worker, /norva_reconcile_resend_contacts/);
  assert.match(worker, /claim_resend_audience_outbox/);
  assert.match(worker, /complete_resend_audience_outbox/);
  assert.match(worker, /fail_resend_audience_outbox/);
  assert.match(lifecycle, /trial_reminder: "db_cron_canonical"/);
  assert.doesNotMatch(lifecycle, /runTrialReminder|LC_TRIAL/);
});

test('winback and abandoned sends are gated before email and before push', () => {
  const winback = lifecycle.slice(lifecycle.indexOf('async function runWinback'), lifecycle.indexOf('async function runAbandoned'));
  assert.match(winback, /select\("user_id,last_event_at,status"\)/);
  assert.match(winback, /gte\("last_event_at", lo\)\.lte\("last_event_at", hi\)/);
  assert.ok((winback.match(/marketingEmailAllowed/g) || []).length >= 1);
  assert.match(winback, /marketing: true/);

  const abandoned = lifecycle.slice(lifecycle.indexOf('async function runAbandoned'), lifecycle.indexOf('async function runExpirePastDue'));
  assert.ok((abandoned.match(/marketingEmailAllowed/g) || []).length >= 1);
  assert.match(abandoned, /marketing: true/);
  assert.match(abandoned, /unsubscribeUrl: context\.unsubscribeUrl/);
});

test('only marketing templates override the transactional unsubscribe fallback', () => {
  assert.doesNotMatch(templates, /DEFAULT_UNSUBSCRIBE_URL/);
  assert.match(templates, /Only marketing templates receive an unsubscribe control/);
  assert.match(templates, /renderWinback\(firstName: string \| null, opts: \{ unsubscribeUrl\?: string \} = \{\}\)/);
  assert.match(templates, /unsubscribeUrl: opts\.unsubscribeUrl/);
  assert.match(templates, /renderTrialEnding/);
  assert.match(templates, /renderPaymentFailed/);
  assert.match(lifecycle, /p_request_headers: unsubscribeHeaders/);
  assert.match(deliveryMigration, /List-Unsubscribe-Post/);
  assert.match(lifecycle, /BILLING_LIVE && LC_DUNNING && LC_EXPIRE/);
});

test('self-host passes every fail-closed marketing prerequisite to Edge Runtime', () => {
  assert.match(compose, /NORVA_POSTAL_ADDRESS:\s*\$\{NORVA_POSTAL_ADDRESS:-\}/);
  assert.match(compose, /NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET:\s*\$\{NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET:-\}/);
  assert.match(compose, /RESEND_WEBHOOK_SECRET:\s*\$\{RESEND_WEBHOOK_SECRET:-\}/);
  assert.match(envExample, /NORVA_LIFECYCLE_UNSUBSCRIBE_SECRET=/);
  assert.match(envExample, /RESEND_WEBHOOK_SECRET=/);
  assert.match(envExample, /NORVA_LC_WINBACK=false/);
  assert.match(envExample, /NORVA_LC_ABANDONED=false/);
});
