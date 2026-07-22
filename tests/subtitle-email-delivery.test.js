const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.resolve(__dirname, '..');
const templatePath = path.join(root, 'supabase/functions/_shared/subtitle-ready-email.ts');
const playbackPath = path.join(root, 'supabase/functions/norva-playback/index.ts');
const migrationPath = path.join(root, 'supabase/migrations/20260722001000_subtitle_email_delivery_outbox.sql');

test('subtitle-ready template is premium, client-safe multipart and uses non-PII tags', async () => {
  const { renderSubtitleReadyEmail } = await importTypescriptModule(templatePath);
  const rendered = renderSubtitleReadyEmail({
    titleLabel: 'A <script>alert("x")</script> Story',
    siteUrl: 'https://norva.tv',
    ctaUrl: 'https://norva.tv/app#movies/open:test',
  });

  assert.match(rendered.html, /<!doctype html>/i);
  assert.match(rendered.html, /<html lang="en" dir="ltr">/i);
  assert.match(rendered.html, /data-preheader="true"/i);
  assert.match(rendered.html, /role="presentation"/i);
  assert.match(rendered.html, /x-apple-disable-message-reformatting/i);
  assert.match(rendered.html, /color:#bcc5d6/i);
  assert.doesNotMatch(rendered.html, /display\s*:\s*(?:flex|grid)/i);
  assert.doesNotMatch(rendered.html, /<script>/i);
  assert.match(rendered.html, /A &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; Story/);
  assert.match(rendered.text, /Your AI subtitles are ready/);
  assert.match(rendered.text, /support@norva\.tv/);
  assert.doesNotMatch(rendered.text, /<\/?(?:html|table|tr|td|p|a)\b/i);
  assert.deepEqual(rendered.tags, [
    { name: 'app', value: 'norva' },
    { name: 'category', value: 'transactional' },
    { name: 'flow', value: 'subtitle_ready' },
  ]);
  assert.ok(!rendered.tags.some(({ value }) => /story|@|script/i.test(value)));
});

test('subtitle-ready template refuses unsafe CTA protocols and uses title-neutral copy', async () => {
  const { renderSubtitleReadyEmail } = await importTypescriptModule(templatePath);
  const rendered = renderSubtitleReadyEmail({ titleLabel: '', ctaUrl: 'javascript:alert(1)' });
  assert.match(rendered.subject, /your title/i);
  assert.match(rendered.html, /href="https:\/\/norva\.tv\/?"/);
  assert.doesNotMatch(rendered.html, /javascript:/i);
  assert.doesNotMatch(rendered.text, /your film/i);
});

test('playback sender resolves current identity and freezes a complete Resend request', () => {
  const source = fs.readFileSync(playbackPath, 'utf8');
  assert.match(source, /segments\[0\] === "subtitle-email-delivery"/);
  assert.match(source, /norva_verify_cron_secret/);
  assert.match(source, /auth\.admin\.getUserById\(claim\.user_id\)/);
  assert.match(source, /user_id: userId, email: ""/);
  assert.match(source, /prepare_subtitle_email_delivery/);
  assert.match(source, /p_request_text: rendered\.text/);
  assert.match(source, /p_request_tags: rendered\.tags/);
  assert.match(source, /reply_to: prepared\.request_reply_to/);
  assert.match(source, /text: prepared\.request_text/);
  assert.match(source, /tags: prepared\.request_tags/);
  assert.match(source, /"Idempotency-Key": claim\.delivery_key/);
  assert.match(source, /AbortSignal\.timeout\(RESEND_TIMEOUT_MS\)/);
  assert.match(source, /res\.ok && emailId/);
  assert.match(source, /\[redacted-email\]/);
  assert.match(source, /if \(transportAccepted\)/);
  assert.match(source, /accepted subtitle email acknowledgement failed/);
});

test('ready callbacks queue delivery and never send Resend inline', () => {
  const source = fs.readFileSync(playbackPath, 'utf8');
  const dispatchStart = source.indexOf('async function dispatchSubtitleNotifications');
  const callbackStart = source.indexOf('async function runTranscribeCallback', dispatchStart);
  const dispatch = source.slice(dispatchStart, callbackStart);
  assert.ok(dispatchStart > 0 && callbackStart > dispatchStart);
  assert.match(dispatch, /queue_subtitle_ready_email_deliveries/);
  assert.doesNotMatch(dispatch, /api\.resend\.com|sendPreparedSubtitleEmail/);
  assert.doesNotMatch(source, /function sendSubtitleReadyEmail|function subtitleReadyEmailHtml/);
  assert.match(source, /already: "ready", email_queued: true/);
});

test('subtitle email SQL outbox has atomic queueing, leases and duplicate barriers', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  assert.match(sql, /create table if not exists public\.catalog_subtitle_email_deliveries/);
  assert.match(sql, /notification_id uuid not null unique/);
  assert.match(sql, /delivery_key text not null unique/);
  assert.match(sql, /delivery_key = 'norva-subtitle-ready-' \|\| notification_id::text/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.catalog_subtitle_email_deliveries from public, anon, authenticated/);
  assert.match(sql, /references public\.catalog_generated_subtitle_notifications\(id\) on delete cascade/);
  assert.match(sql, /references auth\.users\(id\) on delete cascade/);
  assert.match(sql, /delete from public\.catalog_generated_subtitle_notifications n/);
  assert.match(sql, /validate constraint catalog_generated_subtitle_notifications_user_id_fkey/);
  assert.match(sql, /delete from public\.catalog_subtitle_email_deliveries d/);
  assert.match(sql, /validate constraint catalog_subtitle_email_deliveries_notification_id_fkey/);
  assert.match(sql, /validate constraint catalog_subtitle_email_deliveries_user_id_fkey/);
  assert.match(sql, /for update skip locked/);
  assert.match(sql, /lease_token uuid/);
  assert.match(sql, /lease_expires_at timestamptz/);
  assert.match(sql, /norva_queue_subtitle_email_from_cache/);
  assert.match(sql, /norva_queue_subtitle_email_from_opt_in/);
  assert.match(sql, /reconcile_subtitle_ready_email_deliveries/);
  assert.match(sql, /perform public\.reconcile_subtitle_ready_email_deliveries/);
  assert.match(sql, /norva_cancel_subtitle_email_on_opt_out/);
  assert.match(sql, /insert into public\.cloud_content_events/);
  assert.match(sql, /bell_created_at = v_now/);
});

test('subtitle email SQL freezes multipart content and retries safely to a dead letter', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  for (const column of [
    'recipient_email', 'request_from', 'request_reply_to', 'request_subject',
    'request_html', 'request_text', 'request_tags',
  ]) assert.match(sql, new RegExp(`${column} text|${column} jsonb`));
  assert.match(sql, /prepare_subtitle_email_delivery/);
  assert.match(sql, /coalesce\(d\.request_text, p_request_text\)/);
  assert.match(sql, /coalesce\(d\.request_tags, p_request_tags\)/);
  assert.match(sql, /set email = ''/);
  assert.match(sql, /recipient_email = null/);
  assert.match(sql, /request_html = null/);
  assert.match(sql, /title_label = null/);
  assert.match(sql, /norva_safe_subtitle_email_provider_response/);
  assert.match(sql, /norva_redact_subtitle_email_text/);
  assert.match(sql, /email = '', title_label = null, source_id = null, series_id = null/);
  assert.match(sql, /p_http_status not between 200 and 299/);
  assert.match(sql, /nullif\(btrim\(p_resend_email_id\), ''\) is null/);
  assert.match(sql, /power\(2::numeric/);
  assert.match(sql, /p_retry_after_seconds/);
  assert.match(sql, /status = case when v_terminal then 'dead_letter' else 'pending' end/);
  assert.match(sql, /updated_at < now\(\) - interval '30 days'/);
  assert.match(sql, /cron\.schedule\('norva-subtitle-email-delivery'/);
  assert.match(sql, /https:\/\/api\.norva\.tv\/functions\/v1\/norva-playback\/subtitle-email-delivery/);
  assert.doesNotMatch(sql, /oupsceccxsonaalhueff\.supabase\.co/);
});

test('ambiguous subtitle sends never replay outside the Resend idempotency window', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const source = fs.readFileSync(playbackPath, 'utf8');
  assert.match(sql, /idempotency_started_at timestamptz/);
  assert.match(sql, /delivery_uncertain boolean not null default false/);
  assert.match(sql, /quarantined_at timestamptz/);
  assert.match(sql, /create or replace function public\.authorize_subtitle_email_delivery/);
  assert.match(sql, /idempotency_started_at <= v_now - interval '23 hours'/);
  assert.match(sql, /last_error = 'idempotency_window_expired_unconfirmed'/);
  assert.match(source, /authorize_subtitle_email_delivery/);
  assert.ok(source.indexOf('authorize_subtitle_email_delivery') < source.indexOf('sendPreparedSubtitleEmail(claim, prepared)'));
  assert.match(source, /type === "concurrent_idempotent_requests"/);
  assert.match(source, /type === "invalid_idempotent_request"/);
  assert.match(source, /p_ambiguous: ambiguous/);
});

test('operator docs forbid blind replay of uncertain or quarantined deliveries', () => {
  const docs = fs.readFileSync(path.join(root, 'docs/SUBTITLE-EMAIL-DELIVERY.md'), 'utf8');
  assert.match(docs, /23-hour safety window/);
  assert.match(docs, /quarantined_at is null and not delivery_uncertain/);
  assert.match(docs, /Never reopen a quarantined or uncertain row/);
});
