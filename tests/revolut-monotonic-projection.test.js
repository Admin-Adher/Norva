const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('Revolut non-checkout projection has a database-side causal cursor', () => {
  const sql = read('supabase/migrations/20260721121000_revolut_monotonic_projection.sql');
  assert.match(sql, /cloud_revolut_projection_cursor/);
  assert.match(sql, /apply_revolut_entitlement_event/);
  assert.match(sql, /p_event_at <= v_cursor\.last_event_at/);
  assert.match(sql, /p_event_id = v_cursor\.last_event_id/);
  assert.match(sql, /last_projection_applied/);
  assert.match(sql, /last_result/);
  assert.match(sql, /pg_advisory_xact_lock/);
});

test('Revolut lifecycle events cannot overwrite another rail or a hard/internal state', () => {
  const sql = read('supabase/migrations/20260721121000_revolut_monotonic_projection.sql');
  assert.match(sql, /public\.norva_is_internal_account\(p_user_id\)/);
  assert.match(sql, /v_projection\.status in \('revoked', 'refunded', 'fraud'\)/);
  assert.match(sql, /lower\(coalesce\(v_projection\.provider, ''\)\) <> 'revolut'/);
  assert.match(sql, /current_projection\.provider[\s\S]*= 'revolut'/);
  assert.match(sql, /current_projection\.status not in \('revoked', 'refunded', 'fraud'\)/);
  assert.doesNotMatch(sql, /v_projection\.status\s*=\s*'expired'[\s\S]*v_result\s*:=\s*'applied'/);
});

test('Revolut webhook uses authoritative order freshness instead of delivery time', () => {
  const source = read('supabase/functions/norva-revolut-webhook/index.ts');
  const patchStart = source.indexOf('function projectionPatch');
  const patchEnd = source.indexOf('// AUTHORISED is the successful final state', patchStart);
  const projection = source.slice(patchStart, patchEnd);
  assert.match(projection, /authoritativeOrderEventAt\(order\)/);
  assert.match(projection, /stringOrNull\(order\.updated_at\)/);
  assert.match(projection, /last_event_at: eventAt/);
  assert.doesNotMatch(projection, /last_event_at: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /p_event_at: eventAt/);
  assert.match(source, /p_event_id: eventId/);
});

test('obsolete order event names cannot contradict the re-fetched order state', () => {
  const source = read('supabase/functions/norva-revolut-webhook/index.ts');
  const start = source.indexOf('function statusForEvent');
  const end = source.indexOf('function planForMeta', start);
  const mapper = source.slice(start, end);
  assert.match(mapper, /authoritativeOrderState !== "COMPLETED"/);
  assert.match(mapper, /\["FAILED", "DECLINED", "CANCELLED"\]\.includes\(authoritativeOrderState\)/);
  assert.match(mapper, /Subscription notifications need the authoritative Subscription object/);
  assert.doesNotMatch(mapper, /case "SUBSCRIPTION_OVERDUE":\s*return "past_due"/);
});

test('Revolut cursor advances on intentional rejection but not on stale delivery', () => {
  const sql = read('supabase/migrations/20260721121000_revolut_monotonic_projection.sql');
  const stale = sql.slice(sql.indexOf("return query select false, 'stale'"), sql.indexOf('select * into v_projection'));
  assert.doesNotMatch(stale, /insert into public\.cloud_revolut_projection_cursor/);
  const reject = sql.slice(sql.indexOf('if public.norva_is_internal_account'), sql.indexOf('return query select v_applied'));
  assert.match(reject, /insert into public\.cloud_revolut_projection_cursor/);
  assert.match(reject, /last_event_at = excluded\.last_event_at/);
});
