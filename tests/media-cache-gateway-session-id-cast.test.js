'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const sourceMigrations = [
  '20260901223000_media_cache_gateway_publication_v1.sql',
  '20260902093000_media_cache_singleflight_runtime_v1.sql',
  '20260902094500_media_cache_demand_continuation_v1.sql',
  '20260902100000_media_cache_live_join_v1.sql',
  '20260902103000_media_cache_governance_v1.sql',
].map((name) => fs.readFileSync(path.join(root, 'supabase', 'migrations', name), 'utf8'));
const repair = fs.readFileSync(path.join(
  root,
  'supabase',
  'migrations',
  '20260903120000_media_cache_gateway_session_id_cast_v1.sql',
), 'utf8');
const postgresCanary = fs.readFileSync(path.join(
  root,
  'ops',
  'hetzner',
  'media',
  'run-private-media-cache-postgres-canary.sh',
), 'utf8');

test('fresh media cache migrations compare the external text id through an explicit cast', () => {
  const source = sourceMigrations.join('\n');
  assert.equal(
    (source.match(/gateway\.external_session_id = p_gateway_session_id::text/g) || []).length,
    8,
  );
  assert.doesNotMatch(
    source,
    /gateway\.external_session_id = p_gateway_session_id(?!::text)/,
  );
});

test('the live repair is bounded to every affected Gateway RPC and fails closed on drift', () => {
  for (const name of [
    'norva_abandon_media_cache_producer_for_gateway',
    'norva_commit_admitted_media_cache_publication',
    'norva_commit_media_cache_publication',
    'norva_complete_media_cache_producer_for_gateway',
    'norva_pulse_media_cache_continuation_for_gateway',
    'norva_pulse_media_cache_producer_for_gateway',
    'norva_request_media_cache_continuation_for_gateway',
  ]) {
    assert.match(repair, new RegExp(`public\\.${name}\\(`));
  }
  assert.match(repair, /pg_catalog\.to_regprocedure\(v_signature\)/);
  assert.match(repair, /pg_catalog\.pg_get_functiondef\(v_function\)/);
  assert.match(repair, /pg_catalog\.strpos\(v_definition, v_needle \|\| '::text'\)/);
  assert.match(repair, /v_needle \|\| '::text'/);
  assert.match(repair, /required media cache Gateway RPC is missing/);
  assert.match(repair, /media cache Gateway RPC comparison drifted/);
  assert.match(repair, /media cache Gateway RPC cast repair failed/);
});

test('the isolated PostgreSQL cache canary applies the live repair migration', () => {
  assert.match(
    postgresCanary,
    /20260903120000_media_cache_gateway_session_id_cast_v1\.sql/,
  );
  assert.match(postgresCanary, /'migrations', 10/);
  assert.match(postgresCanary, /schema_mode=upgrade/);
  assert.match(postgresCanary, /schema_mode=fresh/);
  assert.match(postgresCanary, /norva_pulse_media_cache_producer_for_gateway/);
  assert.match(postgresCanary, /Gateway producer pulse cast smoke did not return missing/);
});
