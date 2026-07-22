import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { syncResendContactProjection } from '../supabase/functions/_shared/resend-audience.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const response = (status, payload = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('existing contact reconciliation updates properties, memberships and consent topic', async () => {
  const calls = [];
  const replies = [
    response(200, { id: 'contact-1' }),
    response(200, { data: [{ id: 'legacy-segment' }] }),
    response(200, {}),
    response(200, {}),
    response(200, {}),
  ];
  const result = await syncResendContactProjection({
    apiKey: 'test-key',
    email: 'Person@Example.com',
    unsubscribed: true,
    firstName: 'Ada',
    properties: { account_class: 'internal', source_count: 5, unsafe: { nested: true } },
    desiredSegmentIds: ['onboarding-segment'],
    managedSegmentIds: ['onboarding-segment', 'legacy-segment'],
    topicId: 'topic-1',
    topicSubscription: 'opt_out',
    minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return replies.shift();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => [call.options.method, new URL(call.url).pathname]), [
    ['PATCH', '/contacts/person%40example.com'],
    ['GET', '/contacts/contact-1/segments'],
    ['POST', '/contacts/contact-1/segments/onboarding-segment'],
    ['DELETE', '/contacts/contact-1/segments/legacy-segment'],
    ['PATCH', '/contacts/contact-1/topics'],
  ]);
  assert.deepEqual(calls[0].body, {
    unsubscribed: true,
    first_name: 'Ada',
    properties: { account_class: 'internal', source_count: 5 },
  });
  assert.deepEqual(calls.at(-1).body, [{ id: 'topic-1', subscription: 'opt_out' }]);
});

test('membership reconciliation paginates and clears obsolete first-name personalization', async () => {
  const calls = [];
  const replies = [
    response(200, { id: 'contact-page' }),
    response(200, { data: [{ id: 'foreign-1' }], has_more: true }),
    response(200, { data: [{ id: 'managed-old' }], has_more: false }),
    response(200, {}),
    response(200, {}),
  ];
  const result = await syncResendContactProjection({
    apiKey: 'test-key', email: 'page@example.com', unsubscribed: true,
    firstName: null, desiredSegmentIds: [], managedSegmentIds: ['managed-old'],
    topicId: 'topic-1', minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return replies.shift();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].body.first_name, '');
  assert.equal(new URL(calls[1].url).searchParams.get('limit'), '100');
  assert.equal(new URL(calls[2].url).searchParams.get('after'), 'foreign-1');
  assert.equal(calls[3].options.method, 'DELETE');
  assert.match(new URL(calls[3].url).pathname, /\/segments\/managed-old$/);
});

test('missing contact is created atomically with segments and explicit topic state', async () => {
  const calls = [];
  const result = await syncResendContactProjection({
    apiKey: 'test-key',
    email: 'new@example.com',
    unsubscribed: false,
    properties: { onboarding_stage: 'no_source' },
    desiredSegmentIds: ['onboarding-segment'],
    managedSegmentIds: ['onboarding-segment'],
    topicId: 'topic-1',
    topicSubscription: 'opt_in',
    minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      return calls.length === 1 ? response(404, { message: 'not found' }) : response(201, { id: 'contact-2' });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(calls[1].body.segments, [{ id: 'onboarding-segment' }]);
  assert.deepEqual(calls[1].body.topics, [{ id: 'topic-1', subscription: 'opt_in' }]);
});

test('explicit duplicate-contact conflict reconciles, while a generic 409 remains an error', async () => {
  const duplicateCalls = [];
  const duplicateReplies = [
    response(404, { message: 'not found' }),
    response(409, { name: 'validation_error', message: 'Contact already exists' }),
    response(200, { id: 'contact-existing' }),
    response(200, { data: [] }),
    response(200, {}),
  ];
  const duplicate = await syncResendContactProjection({
    apiKey: 'test-key', email: 'duplicate@example.com', unsubscribed: true,
    desiredSegmentIds: [], managedSegmentIds: [], topicId: 'topic-1', minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      duplicateCalls.push([options.method, new URL(url).pathname]);
      return duplicateReplies.shift();
    },
  });
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicateCalls.slice(0, 3), [
    ['PATCH', '/contacts/duplicate%40example.com'],
    ['POST', '/contacts'],
    ['PATCH', '/contacts/duplicate%40example.com'],
  ]);

  const genericCalls = [];
  const generic = await syncResendContactProjection({
    apiKey: 'test-key', email: 'conflict@example.com', unsubscribed: true,
    desiredSegmentIds: [], managedSegmentIds: [], topicId: 'topic-1', minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      genericCalls.push([options.method, new URL(url).pathname]);
      return genericCalls.length === 1
        ? response(404, { message: 'not found' })
        : response(409, { name: 'concurrent_idempotent_requests', message: 'Another request is in progress' });
    },
  });
  assert.equal(generic.ok, false);
  assert.equal(generic.httpStatus, 409);
  assert.equal(genericCalls.length, 2);
});

test('contact creation POST is never retried after network, rate-limit or server ambiguity', async () => {
  const failures = [
    { label: 'network', value: new Error('socket closed') },
    { label: 'rate-limit', value: response(429, { message: 'rate limited' }) },
    { label: 'server', value: response(503, { message: 'temporarily unavailable' }) },
  ];
  for (const failure of failures) {
    const calls = [];
    const result = await syncResendContactProjection({
      apiKey: 'test-key', email: `${failure.label}@example.com`, unsubscribed: true,
      desiredSegmentIds: [], managedSegmentIds: [], topicId: 'topic-1', minIntervalMs: 0,
      fetchImpl: async (url, options) => {
        calls.push([options.method, new URL(url).pathname]);
        if (calls.length === 1) return response(404, { message: 'not found' });
        if (failure.value instanceof Error) throw failure.value;
        return failure.value;
      },
    });
    assert.equal(result.ok, false, failure.label);
    assert.equal(calls.length, 2, failure.label);
    assert.equal(calls[1][0], 'POST', failure.label);
  }
});

test('segment membership POST is single-attempt and ambiguous failure is left for reconciliation', async () => {
  const calls = [];
  const replies = [
    response(200, { id: 'contact-membership' }),
    response(200, { data: [] }),
    response(503, { message: 'temporarily unavailable' }),
  ];
  const result = await syncResendContactProjection({
    apiKey: 'test-key', email: 'membership@example.com', unsubscribed: true,
    desiredSegmentIds: ['segment-1'], managedSegmentIds: ['segment-1'],
    topicId: 'topic-1', minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push([options.method, new URL(url).pathname]);
      return replies.shift();
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1), ['POST', '/contacts/contact-membership/segments/segment-1']);
});

test('successful update without id retrieves contact before membership reconciliation', async () => {
  const calls = [];
  const replies = [
    response(200, { object: 'contact' }),
    response(200, { id: 'contact-3' }),
    response(200, { data: [] }),
    response(200, {}),
  ];
  const result = await syncResendContactProjection({
    apiKey: 'test-key', email: 'shape@example.com', unsubscribed: true,
    desiredSegmentIds: [], managedSegmentIds: [], topicId: 'topic-1',
    minIntervalMs: 0,
    fetchImpl: async (url, options) => {
      calls.push([options.method, new URL(url).pathname]);
      return replies.shift();
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.slice(0, 2), [
    ['PATCH', '/contacts/shape%40example.com'],
    ['GET', '/contacts/shape%40example.com'],
  ]);
});

test('canonical taxonomy is bounded, consent-based and data-minimized', () => {
  const baseSql = read('supabase/migrations/20260721203000_resend_contact_data_model.sql');
  const sql = read('supabase/migrations/20260722004000_resend_contact_ops_worker.sql');
  const model = `${baseSql}\n${sql}`;
  const lifecycle = read('supabase/functions/norva-lifecycle/index.ts');
  for (const slug of [
    'internal-pilots', 'onboarding', 'trialing', 'active-subscribers',
    'cancel-scheduled', 'payment-recovery', 'churned', 'blocked-suppressed',
    'catalog-ready', 'product-news-offers',
  ]) assert.match(model, new RegExp(`'${slug}'`));
  for (const property of [
    'norva_contact_key', 'account_class', 'identity_state', 'entitlement_state', 'onboarding_stage',
    'catalog_health', 'source_count', 'ready_source_count', 'engagement_stage',
    'signup_cohort', 'locale', 'country_code',
  ]) assert.match(sql, new RegExp(`'${property}'`));
  assert.doesNotMatch(sql, /provider_password|provider_username|stream_url|catalog_title/);
  assert.match(baseSql, /cloud_marketing_consent_events/);
  assert.doesNotMatch(lifecycle, /syncResendContactProjection|RESEND_MANAGEMENT_API_KEY/);
  const projection = sql.slice(
    sql.indexOf('create or replace function public.norva_resend_contact_projection'),
    sql.indexOf('revoke all on function public.norva_resend_contact_projection'),
  );
  assert.doesNotMatch(projection, /'norva_user_id'|'signup_at'|'last_active_at'/);
});

test('segment eligibility separates active, recovery, churn and onboarding journeys', () => {
  const sql = read('supabase/migrations/20260722004000_resend_contact_ops_worker.sql');
  assert.match(sql, /v_entitlement_state = 'active'[\s\S]*array_append\(v_segments, 'active-subscribers'\)/);
  assert.match(sql, /v_entitlement_state = 'cancel_scheduled'[\s\S]*array_append\(v_segments, 'cancel-scheduled'\)/);
  assert.match(sql, /v_entitlement_state in \('grace', 'past_due'\)/);
  assert.match(sql, /v_entitlement_state in \('none', 'trialing', 'active'\)/);
  assert.match(sql, /v_identity_state = 'disabled' or v_delivery_suppressed or v_entitlement_state = 'blocked'/);
  assert.match(sql, /v_entitlement_state = 'expired'[\s\S]*array_append\(v_segments, 'churned'\)/);
  assert.match(sql, /v_entitlement_state = 'blocked'[\s\S]*array_append\(v_segments, 'blocked-suppressed'\)/);
  assert.doesNotMatch(sql, /v_entitlement_state in \('active', 'cancel_scheduled'\)/);
});

test('active users with a permanent delivery suppression only enter the remediation cohort', () => {
  const sql = read('supabase/migrations/20260722004000_resend_contact_ops_worker.sql');
  const projection = sql.slice(
    sql.indexOf('create or replace function public.norva_resend_contact_projection'),
    sql.indexOf('revoke all on function public.norva_resend_contact_projection'),
  );
  assert.match(projection, /cloud_email_suppressions[\s\S]*s\.active[\s\S]*into v_delivery_suppressed/);
  assert.match(projection, /v_identity_state = 'disabled' or v_delivery_suppressed or v_entitlement_state = 'blocked'[\s\S]*array_append\(v_segments, 'blocked-suppressed'\)/);
  const suppressionBranchStart = projection.search(/else\r?\n    -- Suppression/);
  assert.notEqual(suppressionBranchStart, -1, 'suppression branch must remain explicit');
  const customerCohorts = projection.slice(suppressionBranchStart);
  assert.ok(customerCohorts.indexOf("v_delivery_suppressed") < customerCohorts.indexOf("array_append(v_segments, 'active-subscribers')"));
  assert.match(customerCohorts, /else[\s\S]*array_append\(v_segments, 'active-subscribers'\)/);
});

test('stale or deleted addresses expose no stable Norva identifier to Resend', () => {
  const sql = read('supabase/migrations/20260722004000_resend_contact_ops_worker.sql');
  const staleProjection = sql.slice(
    sql.indexOf('if not is_current_address then'),
    sql.indexOf('select exists(select 1 from public.admin_internal_accounts'),
  );
  assert.match(staleProjection, /'norva_contact_key', 'removed'/);
  assert.match(staleProjection, /'account_class', 'removed'/);
  assert.doesNotMatch(staleProjection, /p_user_id::text/);
});

test('contact revocations have a dedicated minutely SLO-backed worker and bounded local retention', () => {
  const baseSql = read('supabase/migrations/20260721203000_resend_contact_data_model.sql');
  const sql = read('supabase/migrations/20260722004000_resend_contact_ops_worker.sql');
  const worker = read('ops/hetzner/scripts/resend-contact-worker.mjs');
  const lifecycle = read('supabase/functions/norva-lifecycle/index.ts');
  assert.match(baseSql, /order by o\.desired_unsubscribed desc/);
  assert.match(sql, /create or replace function public\.resend_contact_projection_health\(\)/i);
  assert.match(sql, /'opt_out_backlog'/);
  assert.match(sql, /'lag_p95_seconds'/);
  assert.match(sql, /cron\.unschedule\(v_job_id\)/);
  assert.match(sql, /cloud_resend_contact_worker_state/);
  assert.ok(worker.indexOf('norva_reconcile_resend_contacts') < worker.indexOf('claim_resend_audience_outbox'));
  assert.match(worker, /record_resend_contact_worker_heartbeat/);
  assert.match(lifecycle, /url\.pathname\.endsWith\("\/cron\/resend-contacts"\)/);
  assert.match(lifecycle, /return json\(\{ error: "Not found" \}, 404\)/);
});

test('team-wide Resend contacts fail closed until Norva has a dedicated team', () => {
  const provision = read('ops/hetzner/scripts/provision-resend-contact-data.sh');
  const worker = read('ops/hetzner/scripts/resend-contact-worker.mjs');
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const envExample = read('ops/hetzner/.env.hetzner.example');
  assert.match(provision, /RESEND_DEDICATED_TEAM_CONFIRMED/);
  assert.match(provision, /refusing contact provisioning/);
  assert.match(provision, /api_read '\/topics\?limit=1'/);
  assert.match(worker, /projectionEnabled/);
  assert.match(worker, /dedicatedTeamConfirmed/);
  assert.match(compose, /RESEND_CONTACT_PROJECTION_ENABLED: \$\{RESEND_CONTACT_PROJECTION_ENABLED:-false\}/);
  assert.match(envExample, /RESEND_CONTACT_PROJECTION_ENABLED=false/);
  assert.match(envExample, /RESEND_DEDICATED_TEAM_CONFIRMED=false/);
});

test('shared-team runbook forbids deleting global orphan contacts or using empty segments as isolation', () => {
  const runbook = read('docs/RESEND-CONTACT-OPS.md');
  assert.match(runbook, /Shared-team orphan policy/);
  assert.match(runbook, /not automatically safe to delete/);
  assert.match(runbook, /do not patch its global `unsubscribed`/);
  assert.match(runbook, /BuildTrack's authoritative identity, consent and[\s\S]*suppression stores/);
  assert.match(runbook, /Creating empty `Norva · \.\.\.` Segment objects[\s\S]*operationally useless/);
  assert.match(runbook, /use the local `desired_segment_slugs` projection/);
});

test('full-access Resend management credential is isolated from public Edge runtimes', () => {
  const lifecycle = read('supabase/functions/norva-lifecycle/index.ts');
  const provision = read('ops/hetzner/scripts/provision-resend-contact-data.sh');
  const rotate = read('ops/hetzner/scripts/rotate-resend-key.sh');
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const envExample = read('ops/hetzner/.env.hetzner.example');

  assert.doesNotMatch(lifecycle, /RESEND_MANAGEMENT_API_KEY|syncResendContactProjection/);
  assert.match(provision, /Authorization: Bearer \$RESEND_MANAGEMENT_API_KEY/);
  assert.match(rotate, /"permission": "sending_access"/);
  assert.match(rotate, /"domain_id": sys\.argv\[1\]/);
  assert.match(rotate, /full-access management key leaked into/);
  const rotateCreate = rotate.slice(
    rotate.indexOf('api_management_create_once()'),
    rotate.indexOf('api_management_delete_idempotent()'),
  );
  assert.doesNotMatch(rotateCreate, /--retry|--retry-all-errors/);
  assert.match(rotateCreate, /Before rerunning, list API keys and revoke any orphan named/);
  assert.match(rotate, /api_management_create_once '\/api-keys'/);
  const edgeEnvironment = compose.slice(compose.indexOf('environment: &functions-env'), compose.indexOf('command:', compose.indexOf('environment: &functions-env')));
  assert.doesNotMatch(edgeEnvironment, /^\s+RESEND_MANAGEMENT_API_KEY:/m);
  assert.match(compose, /resend-contact-worker:[\s\S]*RESEND_MANAGEMENT_API_KEY/);
  assert.doesNotMatch(compose.slice(compose.indexOf('resend-contact-worker:'), compose.indexOf('\n  db:', compose.indexOf('resend-contact-worker:'))), /^\s+ports:/m);
  assert.match(envExample, /RESEND_MANAGEMENT_API_KEY=/);
});
