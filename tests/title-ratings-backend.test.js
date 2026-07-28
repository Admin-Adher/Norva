'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = 'supabase/migrations/20260728174609_title_ratings_logical_identity_causal.sql';
const LEGACY_MIGRATION = 'supabase/migrations/20260703130000_title_ratings.sql';
const EDGE = 'supabase/functions/norva-cloud/index.ts';

function functionBody(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker}`);
  return source.slice(start, end);
}

test('EXPAND preserves provider rows and performs a re-entrant alias backfill', () => {
  const migration = read(MIGRATION);
  const legacy = read(LEGACY_MIGRATION);

  assert.match(legacy, /unique \(user_id, profile_id, source_id, item_type, item_id\)/);
  assert.match(migration, /add column if not exists title_id uuid/);
  assert.match(migration, /add column if not exists server_revision bigint not null default 0/);
  assert.match(migration, /add column if not exists last_operation_id uuid/);
  assert.match(migration, /update public\.cloud_title_ratings as reaction[\s\S]*set title_id = variant\.title_id/);
  assert.match(migration, /where reaction\.title_id is null[\s\S]*variant\.external_id = reaction\.item_id/);

  assert.doesNotMatch(migration, /drop\s+column\s+(?:if\s+exists\s+)?source_id/i);
  assert.doesNotMatch(migration, /drop\s+column\s+(?:if\s+exists\s+)?item_id/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.cloud_title_ratings/i);
  assert.doesNotMatch(migration, /drop\s+constraint[\s\S]*cloud_title_ratings.*(?:source|item)/i);
});

test('EXPAND constraints enforce account ownership without rejecting the legacy backlog', () => {
  const migration = read(MIGRATION);

  assert.match(migration, /unique index if not exists uidx_cloud_account_profiles_id_user_expand[\s\S]*\(id, user_id\)/);
  assert.match(migration, /unique index if not exists uidx_cloud_titles_id_user_type_expand[\s\S]*\(id, user_id, item_type\)/);
  assert.match(migration, /foreign key \(profile_id, user_id\)[\s\S]*not valid/);
  assert.match(migration, /foreign key \(title_id, user_id, item_type\)[\s\S]*not valid/);
  assert.match(migration, /check \(rating in \(-1, 0, 1\)\) not valid/);
  assert.match(migration, /check \(server_revision >= 0\) not valid/);
  assert.match(migration, /idx_cloud_title_ratings_profile_title_expand[\s\S]*profile_id, title_id, server_revision desc/);
});

test('rollout audit gates CONTRACT on unresolved, orphan and compatibility counters', () => {
  const migration = read(MIGRATION);
  const audit = functionBody(
    migration,
    'create or replace function public.cloud_title_ratings_expand_audit()',
    '-- Preserve attached reactions',
  );

  for (const metric of [
    'unresolved_rows',
    'backfillable_rows',
    'orphan_user_rows',
    'orphan_profile_rows',
    'orphan_source_rows',
    'orphan_title_rows',
    'compatibility_writes_30d',
    'last_compatibility_write_at',
    'contract_ready',
  ]) {
    assert.match(audit, new RegExp(metric));
  }
  assert.match(audit, /operation\.created_at >= now\(\) - interval '30 days'/);
  assert.match(audit, /reaction\.unresolved_rows = 0[\s\S]*compatibility\.compatibility_writes_30d = 0/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
  assert.match(migration, /revoke all on function public\.cloud_title_ratings_expand_audit\(\)[\s\S]*authenticated/);
});

test('CAS allocates server revisions, is strict, and keeps a permanent operation ledger', () => {
  const migration = read(MIGRATION);
  const cas = functionBody(
    migration,
    'create or replace function public.upsert_cloud_title_rating_cas(',
    'revoke all on function public.upsert_cloud_title_rating_cas(',
  );

  assert.match(migration, /create table if not exists public\.cloud_title_rating_operations/);
  assert.match(migration, /operation_id uuid primary key/);
  assert.match(cas, /title-rating-operation:[\s\S]*pg_advisory_xact_lock/);
  assert.match(cas, /title-rating-title:[\s\S]*pg_advisory_xact_lock/);
  assert.match(cas, /where operation\.operation_id = p_operation_id/);
  assert.match(cas, /operation_id was reused with a different request/);
  assert.match(cas, /p_expected_revision <> current_revision/);
  assert.match(cas, /next_revision := current_revision \+ 1/);
  assert.match(cas, /result_rating, result_revision, applied, conflict/);
  assert.doesNotMatch(cas, /next_revision\s*:=\s*p_expected_revision/i);
});

test('CAS synchronizes attached aliases and materializes the exact legacy row', () => {
  const migration = read(MIGRATION);
  const cas = functionBody(
    migration,
    'create or replace function public.upsert_cloud_title_rating_cas(',
    'revoke all on function public.upsert_cloud_title_rating_cas(',
  );

  assert.match(cas, /reaction\.title_id = p_title_id[\s\S]*reaction\.source_id = p_source_id::text/);
  assert.match(cas, /set[\s\S]*title_id = p_title_id,[\s\S]*server_revision = next_revision/);
  assert.match(cas, /insert into public\.cloud_title_ratings/);
  assert.match(cas, /on conflict \(user_id, profile_id, source_id, item_type, item_id\) do update/);
  assert.match(cas, /last_operation_id = excluded\.last_operation_id/);
  assert.match(cas, /p_compatibility_mode[\s\S]*p_expected_revision is null/);
  assert.match(cas, /compatibility_mode[\s\S]*p_compatibility_mode/);
});

test('title merge repoints every reaction without deleting it and bumps authority', () => {
  const migration = read(MIGRATION);
  const merge = functionBody(
    migration,
    'create or replace function public.norva_repoint_title_ratings_on_merge()',
    'drop trigger if exists trg_cloud_titles_repoint_ratings_on_merge',
  );

  assert.match(merge, /before delete|return old/);
  assert.match(merge, /candidate\.provider_tmdb_id = old\.provider_tmdb_id/);
  assert.match(merge, /least\(old\.id::text, canonical_title_id::text\)/);
  assert.match(merge, /greatest\(old\.id::text, canonical_title_id::text\)/);
  assert.match(merge, /coalesce\(max\(reaction\.server_revision\), 0\) \+ 1/);
  assert.match(merge, /order by reaction\.server_revision desc,[\s\S]*reaction\.updated_at desc/);
  assert.match(merge, /update public\.cloud_title_ratings as reaction[\s\S]*title_id = canonical_title_id/);
  assert.match(merge, /update public\.cloud_title_rating_operations[\s\S]*title_id = canonical_title_id/);
  assert.doesNotMatch(merge, /delete\s+from\s+public\.cloud_title_ratings/i);
});

test('Edge dual-reads logical and exact legacy rows with a bounded v2 list contract', () => {
  const edge = read(EDGE);
  const reader = functionBody(
    edge,
    'async function readExactRating(',
    'async function setRating(',
  );

  assert.match(reader, /\.eq\("title_id", identity\.titleId\)/);
  assert.match(reader, /\.eq\("source_id", sourceId\)[\s\S]*\.eq\("item_type", itemType\)[\s\S]*\.eq\("item_id", itemId\)/);
  assert.match(reader, /Promise\.all\(\[[\s\S]*canonicalPromise,[\s\S]*legacyPromise/);
  assert.match(reader, /authoritativeRatingRow/);
  assert.match(reader, /contractVersion: RATING_CONTRACT_VERSION/);
  assert.match(reader, /truncated,[\s\S]*limit,[\s\S]*correlationId/);
  assert.match(reader, /\.limit\(limit \+ 1\)/);
  assert.match(edge, /server_revision is the causal authority/);
  assert.match(edge, /requireRatingUuid\(rawSourceId, "sourceId", correlationId\)/);
});

test('Edge exposes paired expectedRevision/operationId CAS plus measured legacy compatibility', () => {
  const edge = read(EDGE);
  const setter = functionBody(
    edge,
    'async function setRating(',
    'async function getHistoryItem(',
  );

  assert.match(setter, /hasExpectedRevision !== hasOperationId/);
  assert.match(setter, /const compatibilityMode = !hasExpectedRevision/);
  assert.match(setter, /expectedRevision must be a non-negative safe integer/);
  assert.match(setter, /requireRatingUuid\([\s\S]*operationId/);
  assert.match(setter, /db\.rpc\("upsert_cloud_title_rating_cas"/);
  for (const parameter of [
    'p_source_id',
    'p_item_id',
    'p_operation_id',
    'p_expected_revision',
    'p_compatibility_mode',
  ]) {
    assert.match(setter, new RegExp(parameter));
  }
  for (const responseField of [
    'rating:',
    'revision,',
    'applied:',
    'conflict:',
    'idempotent:',
    'compatibilityMode:',
  ]) {
    assert.match(setter, new RegExp(responseField));
  }
  assert.match(setter, /A neutral rating remains a revision tombstone/);
  assert.doesNotMatch(setter, /clientRevision/);
});

test('rating failures expose only stable public codes and a correlation id', () => {
  const edge = read(EDGE);
  const sanitizer = functionBody(
    edge,
    'function rethrowSanitizedRatingError(',
    'function requireRatingUuid(',
  );

  assert.match(sanitizer, /databaseCode === "23503"[\s\S]*rating_identity_invalid/);
  assert.match(sanitizer, /databaseCode === "22023"[\s\S]*rating_request_invalid/);
  assert.match(sanitizer, /startsWith\("PGRST"\)[\s\S]*rating_service_unavailable/);
  assert.match(sanitizer, /rating_storage_unavailable/);
  assert.match(edge, /new HttpError\(status, message, \{ code, correlationId \}\)/);
  assert.match(edge, /requireRatingUuid\([\s\S]*sourceId/);
});

test('locked or stale profile headers cannot silently redirect rating mutations', () => {
  const edge = read(EDGE);
  const resolver = functionBody(
    edge,
    'async function resolveProfileId(',
    'async function listProfiles(',
  );
  const setter = functionBody(
    edge,
    'async function setRating(',
    'async function getHistoryItem(',
  );

  assert.match(resolver, /if \(options\.mutation\)[\s\S]*profile_locked/);
  assert.match(resolver, /if \(options\.mutation\)[\s\S]*profile_unavailable/);
  assert.match(setter, /resolveProfileId\(req, userId, db, \{ mutation: true \}\)/);
});

class RatingCasModel {
  constructor() {
    this.rating = 0;
    this.revision = 0;
    this.operations = new Map();
  }

  apply({ operationId, expectedRevision = null, rating, compatibilityMode = false }) {
    const payload = JSON.stringify({ expectedRevision, rating, compatibilityMode });
    const previous = this.operations.get(operationId);
    if (previous) {
      if (previous.payload !== payload) throw new Error('operation payload mismatch');
      return { ...previous.result, idempotent: true };
    }

    if (!compatibilityMode && expectedRevision !== this.revision) {
      const result = {
        rating: this.rating,
        revision: this.revision,
        applied: false,
        conflict: true,
        idempotent: false,
      };
      this.operations.set(operationId, { payload, result });
      return result;
    }

    this.revision += 1;
    this.rating = rating;
    const result = {
      rating,
      revision: this.revision,
      applied: true,
      conflict: false,
      idempotent: false,
    };
    this.operations.set(operationId, { payload, result });
    return result;
  }
}

test('CAS contract rejects stale intent and replays the original operation result', () => {
  const model = new RatingCasModel();
  const liked = model.apply({ operationId: 'like-1', expectedRevision: 0, rating: 1 });
  assert.deepStrictEqual(liked, {
    rating: 1,
    revision: 1,
    applied: true,
    conflict: false,
    idempotent: false,
  });

  const stale = model.apply({ operationId: 'dislike-stale', expectedRevision: 0, rating: -1 });
  assert.deepStrictEqual(stale, {
    rating: 1,
    revision: 1,
    applied: false,
    conflict: true,
    idempotent: false,
  });
  assert.deepStrictEqual(
    model.apply({ operationId: 'dislike-stale', expectedRevision: 0, rating: -1 }),
    { ...stale, idempotent: true },
  );

  const disliked = model.apply({ operationId: 'dislike-2', expectedRevision: 1, rating: -1 });
  assert.strictEqual(disliked.revision, 2);
  assert.strictEqual(disliked.applied, true);

  // A late network retry returns the operation's original acknowledgement,
  // not the title's newer state.
  assert.deepStrictEqual(
    model.apply({ operationId: 'like-1', expectedRevision: 0, rating: 1 }),
    { ...liked, idempotent: true },
  );

  const legacyClear = model.apply({
    operationId: 'compat-clear',
    rating: 0,
    compatibilityMode: true,
  });
  assert.deepStrictEqual(legacyClear, {
    rating: 0,
    revision: 3,
    applied: true,
    conflict: false,
    idempotent: false,
  });
});
