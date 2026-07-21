import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  norvaEventAllowed,
  normalizedRecipients,
  safeDiagnosticData,
  safeTags,
  verifyWebhookSignature,
} from '../supabase/functions/_shared/resend-webhook.mjs';

test('team-level webhook accepts only explicitly tagged Norva senders', () => {
  assert.equal(norvaEventAllowed('Norva <noreply@norva.tv>', { app: 'norva' }), true);
  assert.equal(norvaEventAllowed('BuildTrack <noreply@buildtrack.test>', { app: 'buildtrack' }), false);
  assert.equal(norvaEventAllowed('Norva <noreply@norva.tv>', {}), false);
  assert.equal(norvaEventAllowed('Other <noreply@other.test>', { app: 'norva' }), false);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function signedHeaders(secretBytes, body, eventId = 'evt_test', timestamp = 1_700_000_000) {
  const signature = crypto.createHmac('sha256', secretBytes)
    .update(`${eventId}.${timestamp}.${body}`)
    .digest('base64');
  return new Headers({
    'svix-id': eventId,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  });
}

test('Resend webhook signature verification rejects tampering and replay', async () => {
  const secretBytes = crypto.randomBytes(32);
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const body = JSON.stringify({ type: 'email.delivered' });
  const headers = signedHeaders(secretBytes, body);

  assert.equal(await verifyWebhookSignature({ secret, headers, rawBody: body, nowSeconds: 1_700_000_100 }), true);
  assert.equal(await verifyWebhookSignature({ secret, headers, rawBody: `${body} `, nowSeconds: 1_700_000_100 }), false);
  assert.equal(await verifyWebhookSignature({ secret, headers, rawBody: body, nowSeconds: 1_700_000_301 }), false);
});

test('webhook persistence strips tracking data and normalizes recipients', () => {
  assert.deepEqual(normalizedRecipients([' Alice@Example.com ', 'alice@example.com', 'invalid']), ['alice@example.com']);
  assert.deepEqual(safeDiagnosticData('email.bounced', {
    bounce: { type: 'Permanent', subType: 'General', message: 'bad mailbox' },
    click: { link: 'https://private.example/token' },
    ip: '192.0.2.1',
    user_agent: 'private',
  }), { type: 'Permanent', subtype: 'General', reason: 'bad mailbox' });
  assert.deepEqual(safeDiagnosticData('email.clicked', {
    click: { link: 'https://private.example/token' }, ip: '192.0.2.1', user_agent: 'private',
  }), {});
  assert.deepEqual(safeDiagnosticData('email.failed', {
    failed: { reason: 'Delivery to alice@example.com failed; see https://private.example/token' },
  }), { reason: 'Delivery to [redacted-email] failed; see [redacted-url]' });
});

test('delivery suppression preserves consent and only permanent bounces suppress', () => {
  const sql = read('supabase/migrations/20260721234000_resend_delivery_observability.sql');
  assert.match(sql, /p_event_type = 'email\.bounced' and lower\(coalesce\(v_diagnostic ->> 'type', ''\)\) = 'permanent'/);
  assert.match(sql, /if p_event_type = 'email\.complained' then/);
  const suppressionBlock = sql.slice(sql.indexOf('-- A bounce is suppressible'), sql.indexOf('return true;', sql.indexOf('-- A bounce is suppressible')));
  assert.match(suppressionBlock, /if p_event_type = 'email\.complained' then[\s\S]*marketing_email_opt_in = false/);
  assert.doesNotMatch(suppressionBlock, /if p_event_type = 'email\.bounced' then[\s\S]*marketing_email_opt_in = false/);
});

test('webhook normalizes both Resend tag representations without losing routing tags', () => {
  assert.deepEqual(safeTags({ app: 'norva', flow: 'account_deleted' }), {
    app: 'norva', flow: 'account_deleted',
  });
  assert.deepEqual(safeTags([
    { name: 'app', value: 'norva' },
    { name: 'flow', value: 'account_deleted' },
  ]), { app: 'norva', flow: 'account_deleted' });
});

test('account deletion webhook evidence never retains the deleted recipient', () => {
  const sql = read('supabase/migrations/20260721235310_account_deletion_delivery_privacy.sql');
  assert.match(sql, /new\.tags ->> 'app'.*= 'norva'/s);
  assert.match(sql, /new\.tags ->> 'flow'.*= 'account_deleted'/s);
  assert.match(sql, /new\.to_emails := '\{\}'::text\[\]/);
  assert.match(sql, /norva_skip_deleted_account_suppression/);
  assert.match(sql, /delete from public\.cloud_email_suppressions/);
});

test('delivery migration is idempotent, out-of-order safe and fail-closes marketing suppressions', () => {
  const sql = read('supabase/migrations/20260721234000_resend_delivery_observability.sql');
  assert.match(sql, /event_id text primary key/);
  assert.match(sql, /on conflict \(event_id\) do nothing/);
  assert.match(sql, /greatest\(cloud_email_delivery_status\.latest_event_at, excluded\.latest_event_at\)/);
  assert.match(sql, /email\.bounced.*email\.complained.*email\.suppressed/s);
  assert.match(sql, /marketing_email_opt_in = false/);
  assert.match(sql, /cloud_email_suppressions s[\s\S]*s\.active/);
  assert.match(sql, /interval '180 days'/);
  assert.match(sql, /interval '400 days'/);
});

test('Resend webhook is configured as signed non-JWT endpoint on both Edge runtimes', () => {
  const config = read('supabase/config.toml');
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const edge = read('supabase/functions/norva-resend-webhook/index.ts');
  assert.match(config, /\[functions\.norva-resend-webhook\]\s*verify_jwt = false/);
  assert.match(compose, /RESEND_WEBHOOK_SECRET: \$\{RESEND_WEBHOOK_SECRET:-\}/);
  assert.match(edge, /norva_record_resend_email_event/);
  assert.match(edge, /invalid_signature/);
  assert.match(edge, /payload_too_large/);
});
