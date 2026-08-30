'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
  .replace(/\r\n?/g, '\n');
const migration = read('supabase/migrations/20260830091654_provisional_provider_identity_lifecycle.sql');
const syncIdentity = read('supabase/functions/_shared/xtream-sync.ts');
const overviewWorker = read('supabase/functions/_shared/provider-overview-backfill.ts');
const sourceSync = read('supabase/functions/norva-source-sync/index.ts');
const adminPage = read('public/js/pages/AdminPage.js');

function section(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  assert.ok(start >= 0, `missing section start: ${startNeedle}`);
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `missing section end: ${endNeedle}`);
  return text.slice(start, end);
}

test('provisional candidates are server-only and cannot become a shared trust key', () => {
  assert.match(migration, /create table if not exists public\.catalog_source_provider_identity_candidates/);
  assert.match(migration, /foreign key \(user_id, source_id\)[\s\S]*references public\.cloud_sources\(user_id, id\)[\s\S]*on delete cascade/);
  assert.match(migration, /resolution_state = 'provisional'/);
  assert.match(migration, /required_evidence = 32[\s\S]*evidence_count < required_evidence/);
  assert.match(migration, /alter table public\.catalog_source_provider_identity_candidates enable row level security/);
  assert.match(migration, /revoke all on table public\.catalog_source_provider_identity_candidates[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete[\s\S]*catalog_source_provider_identity_candidates to service_role/);
  assert.match(migration, /create trigger trg_aaa_provider_account_delete_write_guard[\s\S]*catalog_source_provider_identity_candidates/);

  const sourceClaim = section(
    migration,
    'create or replace function public.claim_source_provider_overview_candidates(',
    'revoke all on function public.claim_source_provider_overview_candidates(',
  );
  assert.match(sourceClaim, /'source:' \|\| source\.id::text as cache_key/);
  assert.match(sourceClaim, /not exists \([\s\S]*catalog_source_provider_identities verified/);
  assert.doesNotMatch(sourceClaim, /catalog_source_provider_identity_candidates/);
});

test('resolver creates a candidate below 32 signals and promotes it atomically at the threshold', () => {
  const resolver = section(
    migration,
    'create or replace function public.norva_resolve_provider_identity(',
    'revoke all on function public.norva_resolve_provider_identity(',
  );
  assert.match(resolver, /security definer[\s\S]*set search_path = ''/);
  assert.match(resolver, /source\.id = p_source_id[\s\S]*source\.source_type = 'xtream'[\s\S]*source\.deleted_at is null/);
  assert.match(resolver, /item\.source_id = p_source_id[\s\S]*item\.user_id = v_user_id/);
  assert.match(resolver, /if v_size < v_min_sample then[\s\S]*insert into public\.catalog_source_provider_identity_candidates[\s\S]*return null/);

  const existingLink = resolver.indexOf('A previously verified source remains verified');
  const sampleBuild = resolver.indexOf('select array_agg(sample.external_id');
  assert.ok(existingLink >= 0 && existingLink < sampleBuild, 'verified link must survive a temporary sample shrink');

  const promotionStart = resolver.indexOf('insert into public.catalog_source_provider_identities as link');
  const candidateDelete = resolver.indexOf('delete from public.catalog_source_provider_identity_candidates candidate', promotionStart);
  const finalReturn = resolver.lastIndexOf('return v_identity;');
  assert.ok(promotionStart > 0 && candidateDelete > promotionStart && finalReturn > candidateDelete);
  assert.match(resolver.slice(promotionStart, finalReturn), /on conflict \(source_id\) do update/);
  assert.doesNotMatch(syncIdentity, /from\("catalog_source_provider_identities"\)\.upsert/);
  assert.match(syncIdentity, /resolver owns the whole lifecycle in one database transaction/);
});

test('provisional overview work uses source-local RPCs and never writes the global catalog', () => {
  const localRecord = section(
    migration,
    'create or replace function public.record_source_provider_overview_outcome(\n  p_user_id uuid,',
    'revoke all on function public.record_source_provider_overview_outcome(',
  );
  assert.match(localRecord, /'source:' \|\| source\.id::text/);
  assert.match(localRecord, /not exists \([\s\S]*catalog_source_provider_identities verified/);
  assert.match(localRecord, /where media\.source_id = p_source_id[\s\S]*media\.user_id = p_user_id/);
  assert.match(localRecord, /where variant\.source_id = p_source_id[\s\S]*variant\.user_id = p_user_id/);
  assert.doesNotMatch(localRecord, /update public\.catalog_titles/);
  assert.doesNotMatch(localRecord, /where link\.identity_id/);

  assert.match(overviewWorker, /identityScope\?: "verified" \| "source"/);
  assert.match(overviewWorker, /claim_source_provider_overview_candidates/);
  assert.match(overviewWorker, /record_source_provider_overview_outcome/);
  assert.match(overviewWorker, /source-provider-cache/);

  const lane = section(sourceSync, 'async function runProviderOverviewFleetLane(', '\nasync function recordSeriesInventoryOutcome(');
  assert.match(lane, /const identityScope = verifiedIdentity\?\.identity_id \? "verified" : "source"/);
  assert.match(lane, /backfillProviderOverviews\(\{[\s\S]*identityScope/);
  assert.doesNotMatch(lane, /skipped: "provider-identity-pending"/);
});

test('admin renders bounded evidence and distinguishes recalculation from attestation', () => {
  const identities = section(adminPage, '    _pageIdentites()', '    // ── Page: Moteur');
  const retry = section(adminPage, '    async _retryProviderIdentity(button)', '    _renderIdentities(list)');
  assert.match(identities, /this\._rpc\('admin_identities_v3'\)/);
  assert.match(identities, /Provisoire · \$\{AdminPage\.n\(evidenceCount\)\}\/\$\{AdminPage\.n\(requiredEvidence\)\} signaux/);
  assert.match(identities, /Recalculer les signaux/);
  assert.match(identities, /Valider manuellement/);
  assert.match(identities, /this\._attestProviderIdentity\(button\)/);
  assert.match(retry, /if \(!\/\^\[0-9a-f\]\{8\}/);
  assert.match(retry, /button\.disabled = true/);
  assert.match(retry, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(retry, /encodeURIComponent\(sourceId\)/);
  assert.doesNotMatch(retry, /JSON\.stringify\(error|error\?\.message|error\.message/);
});
