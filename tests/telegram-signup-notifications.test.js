const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260727135652_telegram_signup_notifications.sql');
const worker = read('supabase/functions/norva-signup-notify/index.ts');
const telegram = read('supabase/functions/_shared/telegram.ts');
const config = read('supabase/config.toml');
const docs = read('docs/TELEGRAM-SIGNUP-NOTIFICATIONS.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('Auth signup freezes one durable allow-listed notification without blocking signup', () => {
  assert.match(migration, /create table if not exists public\.cloud_signup_telegram_outbox/);
  assert.match(migration, /constraint cloud_signup_telegram_user_unique unique \(user_id\)/);
  assert.match(migration, /after insert on auth\.users/);
  assert.match(migration, /for each row execute function public\.norva_enqueue_signup_telegram/);

  const trigger = section(
    migration,
    'create or replace function public.norva_enqueue_signup_telegram()',
    'revoke all on function public.norva_enqueue_signup_telegram()',
  );
  assert.match(trigger, /insert into public\.cloud_signup_telegram_outbox/);
  assert.match(trigger, /on conflict \(user_id\) do nothing/);
  assert.match(trigger, /Norva signup Telegram enqueue failed/);
  assert.match(trigger, /return new/);
});

test('durable enqueue happens before a separately guarded asynchronous wake', () => {
  const trigger = section(
    migration,
    'create or replace function public.norva_enqueue_signup_telegram()',
    'revoke all on function public.norva_enqueue_signup_telegram()',
  );
  assert.ok(trigger.indexOf('insert into public.cloud_signup_telegram_outbox') <
    trigger.indexOf('perform net.http_post'));
  assert.match(trigger, /Best-effort immediate wake/);
  assert.match(trigger, /Norva signup Telegram immediate wake failed/);
  assert.match(trigger, /norva-signup-notify\/cron\/drain/);
  assert.match(trigger, /norva_cron_shared_secret/);
});

test('outbox and worker expose only the approved signup fields', () => {
  for (const field of [
    'user_id',
    'user_email',
    'display_name',
    'auth_provider',
    'email_confirmed',
    'signed_up_at',
  ]) {
    assert.match(worker, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(
    worker,
    /claim\.(?:password|password_hash|refresh_token|access_token|phone|raw_user_meta_data|raw_app_meta_data|ip_address)\b/i,
  );

  const schema = section(
    migration,
    'create table if not exists public.cloud_signup_telegram_outbox',
    'create index if not exists cloud_signup_telegram_due_idx',
  );
  assert.doesNotMatch(schema, /\b(?:password|password_hash|refresh_token|access_token|phone|raw_metadata|ip_address)\b/i);
  assert.match(schema, /state = 'sent'[\s\S]*user_email is null[\s\S]*display_name is null/);
  assert.match(migration, /on delete cascade/);
});

test('every user-controlled Telegram field is bounded and HTML escaped', () => {
  const message = section(worker, 'function signupMessage', 'function retryableTelegramStatus');
  assert.match(message, /clipped\(claim\.user_email, 320\)/);
  assert.match(message, /clipped\(claim\.display_name, 160\)/);
  assert.match(message, /clipped\(claim\.auth_provider, 50\)/);
  assert.match(message, /tgEscape\(email\)/);
  assert.match(message, /tgEscape\(name\)/);
  assert.match(message, /tgEscape\(provider\)/);
  assert.match(message, /tgEscape\(claim\.user_id\.slice\(0, 36\)\)/);
  assert.match(message, /tgEscape\(timestamp\)/);
  assert.match(telegram, /replace\(\/&\/g, "&amp;"\).*replace\(\/<\/g, "&lt;"\).*replace\(\/>\/g, "&gt;"\)/);
});

test('claims are concurrent-worker safe and acknowledgements use exact CAS', () => {
  const claim = section(
    migration,
    'create or replace function public.claim_signup_telegram_deliveries',
    'create or replace function public.complete_signup_telegram_delivery',
  );
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /lease_token = gen_random_uuid\(\)/);
  assert.match(claim, /lease_expires_at = v_now \+ make_interval/);
  assert.match(claim, /attempt_count = o\.attempt_count \+ 1/);
  assert.match(claim, /max_attempts_exhausted/);

  const complete = section(
    migration,
    'create or replace function public.complete_signup_telegram_delivery',
    'create or replace function public.fail_signup_telegram_delivery',
  );
  assert.match(complete, /o\.state = 'processing'/);
  assert.match(complete, /o\.lease_token = p_lease_token/);
  assert.match(complete, /telegram_message_id = p_message_id/);
  assert.match(complete, /user_email = null/);
  assert.match(complete, /display_name = null/);
});

test('transient failures back off, rate limits defer, and permanent failures dead-letter', () => {
  const failure = section(
    migration,
    'create or replace function public.fail_signup_telegram_delivery',
    'create or replace function public.defer_signup_telegram_delivery',
  );
  assert.match(failure, /not coalesce\(p_retryable, false\)/);
  assert.match(failure, /power\(2::numeric/);
  assert.match(failure, /'dead_letter'/);
  assert.match(failure, /'retry_scheduled'/);
  assert.match(worker, /status === 408 \|\| status === 425 \|\| status === 429/);
  assert.match(worker, /defer_signup_telegram_delivery/);
  assert.match(worker, /sent\.retryAfterSeconds \?\? 60/);
});

test('Telegram transport returns proof and safe retry metadata without raw diagnostics', () => {
  assert.match(telegram, /export async function sendTelegramDetailed/);
  assert.match(telegram, /payload\.ok === true && messageId !== null/);
  assert.match(telegram, /result\.message_id/);
  assert.match(telegram, /parameters\.retry_after/);
  assert.match(telegram, /AbortSignal\.timeout\(6000\)/);
  assert.match(telegram, /telegram_transport_timeout/);
  assert.doesNotMatch(telegram, /description|rawResponse|responseText/);
  assert.match(telegram, /return \(await sendTelegramDetailed\(text\)\)\.accepted/);
});

test('worker self-authenticates, stays idle without Telegram secrets, and is scheduled', () => {
  assert.match(worker, /telegramConfigured\(\)/);
  assert.match(worker, /configured: false/);
  assert.match(worker, /admin\.rpc\("norva_verify_cron_secret"/);
  assert.match(worker, /authorized !== true/);
  assert.match(worker, /complete_signup_telegram_delivery/);
  assert.match(worker, /fail_signup_telegram_delivery/);
  assert.match(config, /\[functions\.norva-signup-notify\]\s*\nverify_jwt = false/);
  assert.match(migration, /'norva-signup-telegram-delivery'/);
  assert.match(migration, /'norva-signup-telegram-prune'/);
});

test('runbook documents privacy boundaries, health and manual recovery', () => {
  assert.match(docs, /Passwords, password hashes, access\/refresh tokens, phone numbers/);
  assert.match(docs, /signup_telegram_delivery_health/);
  assert.match(docs, /requeue_signup_telegram_delivery/);
  assert.match(docs, /TELEGRAM_BOT_TOKEN/);
  assert.match(docs, /Telegram has no idempotency-key feature/);
});
