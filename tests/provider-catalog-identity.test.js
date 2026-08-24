'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(
  __dirname,
  '../supabase/functions/_shared/provider-catalog-identity.mjs',
);
const loading = import(pathToFileURL(MODULE_PATH).href);
const DEFAULT_MANIFEST_CHECKSUM = 'a'.repeat(64);
const TRANSITION_MIGRATION = fs.readFileSync(path.resolve(
  __dirname,
  '../supabase/migrations/20260823120000_provider_credential_transition_v1.sql',
), 'utf8');

function nodeMd5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function evidence(ids, options = {}) {
  return {
    movieExternalIds: ids,
    seriesExternalIds: options.seriesExternalIds ?? [],
    sampleComplete: options.sampleComplete ?? true,
    canonicalIdentity: options.canonicalIdentity,
    host: options.host,
    sourceType: options.sourceType,
    categories: options.categories,
    contentManifestChecksum: Object.hasOwn(options, 'contentManifestChecksum')
      ? options.contentManifestChecksum
      : DEFAULT_MANIFEST_CHECKSUM,
  };
}

function identity(id, strength = 'strong') {
  return { id, strength };
}

test('portable MD5 matches node:crypto for ASCII and Unicode UTF-8 vectors', async () => {
  const { portableMd5Hex } = await loading;
  for (const value of [
    '',
    'a',
    'abc',
    'message digest',
    '0123456789'.repeat(8),
    'Café ☃ 🎬',
    '番組表-📺',
  ]) {
    assert.equal(portableMd5Hex(value), nodeMd5(value), JSON.stringify(value));
  }
});

test('normalization, duplicate removal, and input order do not change evidence', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const ids = Array.from({ length: 40 }, (_, index) => `stream-${index}`);
  const current = evidence(
    [...ids.slice().reverse(), ' stream-1 ', 'Café'],
    { seriesExternalIds: ['stream-2', 'Café'] },
  );
  const candidate = evidence(
    ['Café', ...ids, 'stream-2', 'stream-1'],
    { seriesExternalIds: ['Café', 'stream-2'] },
  );

  const result = compareProviderCatalogIdentity({ current, candidate });
  assert.equal(result.decision, 'SAME_CATALOG');
  assert.equal(result.uniqueIdCountCurrent, 43);
  assert.equal(result.uniqueIdCountCandidate, 43);
  assert.equal(result.sampleSizeCurrent, 43);
  assert.equal(result.overlapCount, 43);
  assert.equal(result.similarityScore, 1);
});

test('bottom-256 is selected exactly by MD5 rank, independent of source ordering', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const all = Array.from({ length: 300 }, (_, index) => `external-${index}`);
  const expectedBottom = all
    .map((externalId) => ({ externalId, digest: nodeMd5(`movie:${externalId}`) }))
    .sort((left, right) =>
      (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0) ||
      (left.externalId < right.externalId ? -1 : left.externalId > right.externalId ? 1 : 0))
    .slice(0, 256)
    .map((entry) => entry.externalId);

  const result = compareProviderCatalogIdentity({
    current: evidence(all.slice().reverse()),
    candidate: evidence(expectedBottom),
  });
  assert.equal(result.sampleSizeCurrent, 256);
  assert.equal(result.sampleSizeCandidate, 256);
  assert.equal(result.overlapCount, 256);
  assert.equal(result.unionCount, 256);
  assert.equal(result.similarityScore, 1);
  assert.equal(result.decision, 'SAME_CATALOG');
});

test('SAME_CATALOG starts at Jaccard 0.5 and secondary hints are non-decisive', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const shared = Array.from({ length: 24 }, (_, index) => `shared-${index}`);
  const currentOnly = Array.from({ length: 12 }, (_, index) => `current-${index}`);
  const candidateOnly = Array.from({ length: 12 }, (_, index) => `candidate-${index}`);
  const current = evidence([...shared, ...currentOnly], {
    host: 'https://user:secret@provider.example:8443/path',
    sourceType: 'XTREAM',
    categories: ['Drama', 'Sports'],
  });
  const candidate = evidence([...shared, ...candidateOnly], {
    host: 'different.example',
    sourceType: 'm3u',
    categories: ['News'],
  });

  const atThreshold = compareProviderCatalogIdentity({ current, candidate });
  assert.equal(atThreshold.similarityScore, 0.5);
  assert.equal(atThreshold.decision, 'SAME_CATALOG');
  assert.deepEqual(atThreshold.secondarySignals, {
    hostMatch: false,
    sourceTypeMatch: false,
    categorySimilarity: 0,
  });

  const belowThreshold = compareProviderCatalogIdentity({
    current,
    candidate: evidence([...shared.slice(0, 23), ...candidateOnly, 'candidate-extra'], {
      host: 'provider.example',
      sourceType: 'xtream',
      categories: ['Drama', 'Sports'],
    }),
  });
  assert.ok(belowThreshold.similarityScore < 0.5);
  assert.equal(belowThreshold.decision, 'AMBIGUOUS');
});

test('v2 never auto-classifies DIFFERENT_CATALOG from the overlap-derived registry signal', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const currentIds = Array.from({ length: 40 }, (_, index) => `old-${index}`);
  const candidateIds = Array.from({ length: 40 }, (_, index) => `new-${index}`);
  const oldIdentity = identity('identity-old');
  const newIdentity = identity('identity-new');

  const different = compareProviderCatalogIdentity({
    current: evidence(currentIds, { canonicalIdentity: oldIdentity }),
    candidate: evidence(candidateIds, { canonicalIdentity: newIdentity }),
  });
  assert.equal(different.similarityScore, 0);
  assert.equal(different.decision, 'AMBIGUOUS');

  for (const [label, currentOptions, candidateOptions] of [
    ['current incomplete', { sampleComplete: false, canonicalIdentity: oldIdentity }, { canonicalIdentity: newIdentity }],
    ['candidate incomplete', { canonicalIdentity: oldIdentity }, { sampleComplete: false, canonicalIdentity: newIdentity }],
    ['missing identity', {}, { canonicalIdentity: newIdentity }],
    ['weak identity', { canonicalIdentity: identity('identity-old', 'weak') }, { canonicalIdentity: newIdentity }],
    ['same identity', { canonicalIdentity: oldIdentity }, { canonicalIdentity: oldIdentity }],
  ]) {
    const result = compareProviderCatalogIdentity({
      current: evidence(currentIds, currentOptions),
      candidate: evidence(candidateIds, candidateOptions),
    });
    assert.equal(result.decision, 'AMBIGUOUS', label);
  }
});

test('typed IDs prevent movie and series numeric namespaces from collapsing', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const sequential = Array.from({ length: 40 }, (_, index) => String(index + 1));
  const result = compareProviderCatalogIdentity({
    current: evidence(sequential),
    candidate: evidence([], { seriesExternalIds: sequential }),
  });
  assert.equal(result.uniqueIdCountCurrent, 40);
  assert.equal(result.uniqueIdCountCandidate, 40);
  assert.equal(result.overlapCount, 0);
  assert.equal(result.similarityScore, 0);
  assert.equal(result.decision, 'AMBIGUOUS');
});

test('secondary host comparison preserves a non-default provider port', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const ids = Array.from({ length: 40 }, (_, index) => `id-${index}`);
  const result = compareProviderCatalogIdentity({
    current: evidence(ids, { host: 'https://panel.example:8443/base' }),
    candidate: evidence(ids, { host: 'panel.example:9443' }),
  });
  assert.equal(result.secondarySignals.hostMatch, false);
  assert.equal(result.decision, 'SAME_CATALOG');
});

test('identical local stream IDs are AMBIGUOUS when independent content manifests drift or are absent', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const sequential = Array.from({ length: 40 }, (_, index) => String(index + 1));
  for (const [label, currentChecksum, candidateChecksum] of [
    ['different content', 'a'.repeat(64), 'b'.repeat(64)],
    ['current missing', null, 'b'.repeat(64)],
    ['candidate missing', 'a'.repeat(64), null],
  ]) {
    const result = compareProviderCatalogIdentity({
      current: evidence(sequential, {
        contentManifestChecksum: currentChecksum,
        canonicalIdentity: identity('registry-same'),
      }),
      candidate: evidence(sequential, {
        contentManifestChecksum: candidateChecksum,
        canonicalIdentity: identity('registry-same'),
      }),
    });
    assert.equal(result.similarityScore, 1, label);
    assert.equal(result.contentManifest.matching, false, label);
    assert.equal(result.decision, 'AMBIGUOUS', label);
  }
});

test('a Jaccard score exactly 0.1 is not DIFFERENT_CATALOG', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const shared = Array.from({ length: 10 }, (_, index) => `shared-${index}`);
  const current = [...shared, ...Array.from({ length: 45 }, (_, index) => `old-${index}`)];
  const candidate = [...shared, ...Array.from({ length: 45 }, (_, index) => `new-${index}`)];
  const result = compareProviderCatalogIdentity({
    current: evidence(current, { canonicalIdentity: identity('old') }),
    candidate: evidence(candidate, { canonicalIdentity: identity('new') }),
  });
  assert.equal(result.similarityScore, 0.1);
  assert.equal(result.decision, 'AMBIGUOUS');
});

test('fewer than 32 unique IDs per side is always AMBIGUOUS', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const same31 = Array.from({ length: 31 }, (_, index) => `same-${index}`);
  const result = compareProviderCatalogIdentity({
    current: evidence(same31, { canonicalIdentity: identity('same') }),
    candidate: evidence([...same31, 'same-31'], { canonicalIdentity: identity('same') }),
  });
  assert.ok(result.similarityScore >= 0.5);
  assert.equal(result.decision, 'AMBIGUOUS');
});

test('contradictory strong identities prevent SAME_CATALOG despite high overlap', async () => {
  const { compareProviderCatalogIdentity } = await loading;
  const ids = Array.from({ length: 40 }, (_, index) => `same-${index}`);
  const result = compareProviderCatalogIdentity({
    current: evidence(ids, { canonicalIdentity: identity('old-identity') }),
    candidate: evidence(ids, { canonicalIdentity: identity('new-identity') }),
  });
  assert.equal(result.similarityScore, 1);
  assert.equal(result.strongCanonicalIdentity.contradictory, true);
  assert.equal(result.decision, 'AMBIGUOUS');
});

test('the versioned result contains metrics only and never raw sensitive evidence', async () => {
  const {
    compareProviderCatalogIdentity,
    PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION,
  } = await loading;
  const secretId = 'https://provider.example/live/provider-user/provider-secret/42.ts?token=top-secret';
  const base = Array.from({ length: 40 }, (_, index) => `id-${index}`);
  const result = compareProviderCatalogIdentity({
    current: evidence([...base, secretId], {
      canonicalIdentity: identity('canonical-secret-a'),
      host: 'https://provider-user:provider-secret@provider.example/path?token=top-secret',
      sourceType: 'xtream',
      categories: ['provider-secret-category'],
    }),
    candidate: evidence([...base, secretId], {
      canonicalIdentity: identity('canonical-secret-a'),
      host: 'provider.example',
      sourceType: 'xtream',
      categories: ['provider-secret-category'],
    }),
  });

  assert.equal(result.algorithmVersion, PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION);
  assert.equal(
    PROVIDER_CATALOG_IDENTITY_ALGORITHM_VERSION,
    'xtream-type-streamid-sha256-bottom256-jaccard-manifest-v2',
  );
  assert.match(
    TRANSITION_MIGRATION,
    /xtream-type-streamid-sha256-bottom256-jaccard-manifest-v2/,
  );
  assert.equal(result.decision, 'SAME_CATALOG');
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    secretId,
    'provider-user',
    'provider-secret',
    'top-secret',
    'canonical-secret-a',
    'provider-secret-category',
    'provider.example',
    'movieExternalIds',
    'seriesExternalIds',
    'digests',
    DEFAULT_MANIFEST_CHECKSUM,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `result leaked ${forbidden}`);
  }
});

test('malformed and oversized inputs fail closed before producing a decision', async () => {
  const {
    compareProviderCatalogIdentity,
    portableMd5Hex,
    PROVIDER_CATALOG_IDENTITY_MAX_IDS_PER_KIND,
  } = await loading;
  const valid = evidence(Array.from({ length: 32 }, (_, index) => `id-${index}`));
  const compare = (current, candidate = valid) =>
    compareProviderCatalogIdentity({ current, candidate });

  assert.throws(() => compare(null), /sides_must_be_objects/);
  assert.throws(() => compare({ movieExternalIds: [], seriesExternalIds: 'nope' }), /must_be_an_array/);
  assert.throws(() => compare(evidence(['ok', 42])), /external_id_must_be_string/);
  assert.throws(() => compare(evidence(['   '])), /must_not_be_empty/);
  assert.throws(() => compare(evidence(['bad\u0000id'])), /control_character/);
  assert.throws(() => compare(evidence(['x'.repeat(257)])), /external_id_too_long/);
  assert.throws(
    () => compare({
      ...valid,
      movieExternalIds: new Array(PROVIDER_CATALOG_IDENTITY_MAX_IDS_PER_KIND + 1),
    }),
    /movie_external_ids_too_large/,
  );
  assert.throws(
    () => compare(evidence(valid.movieExternalIds, { sampleComplete: 'yes' })),
    /sample_complete_must_be_boolean/,
  );
  assert.throws(
    () => compare(evidence(valid.movieExternalIds, { canonicalIdentity: identity('', 'strong') })),
    /canonical_identity_id_invalid/,
  );
  assert.throws(
    () => compare(evidence(valid.movieExternalIds, { contentManifestChecksum: 'not-a-checksum' })),
    /content_manifest_checksum_invalid/,
  );
  assert.throws(() => portableMd5Hex(42), /md5_value_must_be_string/);
});
