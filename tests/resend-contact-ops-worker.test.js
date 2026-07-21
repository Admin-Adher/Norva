import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkHealthFile,
  isRetryableResendFailure,
  runCycle,
  sanitizeDiagnostic,
} from '../ops/hetzner/scripts/resend-contact-worker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const response = (status, payload = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

const segmentSlugs = [
  'internal-pilots', 'onboarding', 'trialing', 'active-subscribers',
  'cancel-scheduled', 'payment-recovery', 'churned',
  'blocked-suppressed', 'catalog-ready',
];
const taxonomy = [
  ...segmentSlugs.map((slug) => ({
    kind: 'segment', slug, remote_id: `remote-${slug}`, managed: true, active: true,
  })),
  { kind: 'topic', slug: 'product-news-offers', remote_id: 'topic-1', managed: true, active: true },
];

test('private worker refreshes stale projections before claim and acknowledges sequentially', async () => {
  const calls = [];
  let completeArgs = null;
  const db = {
    async listTaxonomy() { calls.push('taxonomy'); return taxonomy; },
    async rpc(name, args) {
      calls.push(name);
      if (name === 'norva_reconcile_resend_contacts') return 4;
      if (name === 'claim_resend_audience_outbox') return [{
        email: 'person@example.com', desired_unsubscribed: false, first_name: 'Ada',
        contact_properties: { norva_contact_key: 'a'.repeat(64), signup_cohort: '2026-07' },
        desired_segment_slugs: ['active-subscribers'], desired_topic_subscription: 'opt_in',
        revision: 7, lease_token: '11111111-1111-4111-8111-111111111111',
      }];
      if (name === 'complete_resend_audience_outbox') { completeArgs = args; return true; }
      if (name === 'resend_contact_projection_health') return { backlog: 0, opt_out_backlog: 0 };
      if (name === 'record_resend_contact_worker_heartbeat') return null;
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const replies = [
    response(200, { id: 'contact-1' }),
    response(200, { data: [], has_more: false }),
    response(200, {}),
    response(200, {}),
  ];
  const result = await runCycle({
    db,
    managementApiKey: 're_management_test_key',
    fetchImpl: async () => replies.shift(),
    perContactDelayMs: 0,
    resendMinIntervalMs: 0,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.reconciled, 4);
  assert.equal(result.completed, 1);
  assert.ok(calls.indexOf('norva_reconcile_resend_contacts') < calls.indexOf('claim_resend_audience_outbox'));
  assert.ok(calls.indexOf('taxonomy') < calls.indexOf('claim_resend_audience_outbox'));
  assert.deepEqual(completeArgs.p_result.steps.map((step) => step.operation), [
    'patch', 'list_segments', 'add_segment', 'update_topic',
  ]);
  assert.doesNotMatch(JSON.stringify(completeArgs.p_result), /person@example\.com|11111111-/);
});

test('remote diagnostics are redacted before durable retry state', async () => {
  let failureArgs = null;
  const db = {
    async listTaxonomy() { return taxonomy; },
    async rpc(name, args) {
      if (name === 'norva_reconcile_resend_contacts') return 0;
      if (name === 'claim_resend_audience_outbox') return [{
        email: 'private@example.com', desired_unsubscribed: true, first_name: null,
        contact_properties: { norva_contact_key: 'b'.repeat(64) },
        desired_segment_slugs: [], desired_topic_subscription: 'opt_out',
        revision: 2, lease_token: '22222222-2222-4222-8222-222222222222',
      }];
      if (name === 'fail_resend_audience_outbox') { failureArgs = args; return true; }
      if (name === 'resend_contact_projection_health') return { backlog: 1, opt_out_backlog: 1 };
      if (name === 'record_resend_contact_worker_heartbeat') return null;
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const result = await runCycle({
    db,
    managementApiKey: 're_management_test_key',
    fetchImpl: async () => response(422, {
      message: 'bad private@example.com 22222222-2222-4222-8222-222222222222',
    }),
    perContactDelayMs: 0,
    resendMinIntervalMs: 0,
  });

  assert.equal(result.status, 'degraded');
  assert.equal(result.failed, 1);
  assert.equal(result.permanent_failed, 1);
  assert.equal(failureArgs.p_retryable, false);
  assert.match(failureArgs.p_error, /\[redacted-email\].*\[redacted-id\]/);
  assert.doesNotMatch(failureArgs.p_error, /private@example\.com|22222222-/);
  assert.doesNotMatch(JSON.stringify(failureArgs.p_result), /private@example\.com|22222222-/);
});

test('worker retry classification only retries transport, timeout, rate-limit and server failures', () => {
  assert.equal(isRetryableResendFailure(null), true);
  assert.equal(isRetryableResendFailure(408), true);
  assert.equal(isRetryableResendFailure(429), true);
  assert.equal(isRetryableResendFailure(503), true);
  assert.equal(isRetryableResendFailure(400), false);
  assert.equal(isRetryableResendFailure(401), false);
  assert.equal(isRetryableResendFailure(403), false);
  assert.equal(isRetryableResendFailure(422), false);
  assert.equal(isRetryableResendFailure(null, false), false);
});

test('disabled team gate performs no claim or Resend network call', async () => {
  const calls = [];
  const db = {
    async listTaxonomy() { throw new Error('must not list'); },
    async rpc(name) { calls.push(name); return null; },
  };
  const result = await runCycle({
    db,
    managementApiKey: '',
    projectionEnabled: false,
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(result.status, 'disabled');
  assert.deepEqual(calls, ['record_resend_contact_worker_heartbeat']);
});

test('container health is based on a bounded local heartbeat age', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-resend-health-'));
  const file = path.join(dir, 'health.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'ok', written_at: new Date().toISOString() }));
  assert.equal((await checkHealthFile(file, 180)).ok, true);
  fs.writeFileSync(file, JSON.stringify({ status: 'ok', written_at: '2020-01-01T00:00:00.000Z' }));
  assert.equal((await checkHealthFile(file, 180)).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('marketing eligibility is fail-closed and suppression changes requeue contact state', () => {
  const sql = read('supabase/migrations/20260722004000_resend_contact_ops_worker.sql');
  const allowed = sql.slice(
    sql.indexOf('create or replace function public.norva_marketing_email_allowed'),
    sql.indexOf('revoke all on function public.norva_marketing_email_allowed'),
  );
  assert.match(allowed, /u\.email_confirmed_at is not null/);
  assert.match(allowed, /u\.banned_until is null or u\.banned_until <= clock_timestamp\(\)/);
  assert.match(allowed, /not in \('revoked', 'refunded', 'fraud', 'blocked'\)/);
  assert.match(allowed, /cloud_email_suppressions[\s\S]*s\.active/);
  assert.match(sql, /after update of email, raw_user_meta_data, email_confirmed_at, banned_until, deleted_at/);
  assert.match(sql, /after insert or update of active, resolved_at[\s\S]*cloud_email_suppressions/);
  assert.match(sql, /norva_enqueue_resend_suppression_projection/);
  assert.match(sql, /desired_topic_subscription := case[\s\S]*norva_marketing_email_allowed/);
  assert.match(sql, /p_retryable boolean/);
  assert.match(sql, /else 'infinity'::timestamptz/);
  assert.match(sql, /'permanent_failure_count'/);
});

test('provisioning paginates reads, never retries POST and removes v2 direct identifiers', () => {
  const provision = read('ops/hetzner/scripts/provision-resend-contact-data.sh');
  assert.match(provision, /api_list_all\(\)/);
  assert.match(provision, /has_more/);
  assert.match(provision, /after=\$\{after\}/);
  const write = provision.slice(provision.indexOf('api_write_once()'), provision.indexOf('api_list_all()'));
  assert.doesNotMatch(write, /--retry|--retry-all-errors/);
  assert.match(provision, /norva_contact_key\|string/);
  assert.match(provision, /signup_cohort\|string/);
  assert.match(provision, /for key in norva_user_id signup_at last_active_at/);
  assert.match(provision, /configured\/10|\$configured\/10/);
  assert.match(provision, /cancel-scheduled\|Norva/);
});

test('diagnostic sanitizer removes user addresses, UUIDs and bearer material', () => {
  const value = sanitizeDiagnostic(
    `person@example.com 123e4567-e89b-42d3-a456-426614174000 ${'a'.repeat(64)} Bearer abcdefghijklmnopqrstuvwxyz`,
  );
  assert.doesNotMatch(value, /person@example\.com|123e4567|aaaaaaaaaaaaaaaa|abcdefghijklmnop/);
});
