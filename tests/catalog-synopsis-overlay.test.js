const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('synopsis overlay remains active while the risky full display cutover is off', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  const start = src.indexOf('async function applyCatalogOverlay(');
  const end = src.indexOf('function titleRailItem(', start);
  const block = src.slice(start, end);

  assert.match(block, /if \(!catalogReadEnabled\(\)\) \{\s*await applyCatalogTextOverlay\(rows, itemType, lang\);/);
  assert.match(src, /Permanent safe read path for title text removed by cloud_titles self-thinning/);
});

test('shared text is catalog-validated, item-type scoped, projected, and fill-only', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  const start = src.indexOf('async function applyCatalogTextOverlay(');
  const end = src.indexOf('// Full display overlay remains guarded', start);
  const block = src.slice(start, end);

  assert.match(block, /trusted:metadata->tmdbValidation->>valid/);
  assert.match(block, /eligibleRows = rows\.filter\(\(row\) => catalogTextStatusEligible\(row\.match_status\)\)/);
  assert.match(block, /String\(\(row as JsonRecord\)\.trusted\) !== "true"/);
  assert.match(block, /\.eq\("item_type", itemType\)/);
  assert.match(block, /base_overview:metadata->tmdb->>overview/);
  assert.match(block, /loc_overview:metadata->i18n->\$\{lang\}->>overview/);
  assert.match(block, /if \(!existingOverview && baseOverview\)/);
  assert.doesNotMatch(block, /row\.(release_year|poster_url|backdrop_url)\s*=/);
});

test('empty cloud strings fall back and existing provider summaries are preserved', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /stringOrNull\(tmdb\.overview\) \?\? stringOrNull\(metadata\.overview\)/);
  assert.match(src, /stringOrNull\(rowTmdb\.overview\)\s*\?\? stringOrNull\(row\.overview\)/);
  assert.match(src, /const resolvedOverview = cat\.localizedOverview\s*\?\? existingOverview\s*\?\? cat\.fallbackOverview/);
  assert.match(src, /\?\? providerOverview\s*\?\? stringOrNull\(title\.__catalog_base_overview\)/);
});

test('all title rails forward the requested synopsis language', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /applyCatalogOverlay\(selectedRows, itemType, lang\)/);
  assert.equal((src.match(/applyCatalogOverlay\(pageRows, itemType, lang\)/g) || []).length, 2);
  assert.match(src, /applyCatalogOverlay\(\(titles \?\? \[\]\) as JsonRecord\[\], itemType, lang\)/);
  assert.equal((src.match(/applyCatalogOverlay\(titles, itemType, lang\)/g) || []).length, 3);
  assert.equal((src.match(/listVerifiedTitleCandidates\(userId, itemType\)/g) || []).length, 2);
  assert.match(src, /listVerifiedTitleCandidates\(userId, t\)/);
});

test('flat grids avoid movie-series id collisions and support localized synopsis text', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  const start = src.indexOf('async function attachMediaLanguages(');
  const end = src.indexOf('async function listMediaCategories(', start);
  const block = src.slice(start, end);

  assert.match(block, /catalogCandidateIds = new Set<string>/);
  assert.match(block, /weakCatalogIds = new Set<string>/);
  assert.match(block, /for \(const id of weakCatalogIds\) catalogCandidateIds\.delete\(id\)/);
  assert.match(block, /catalogTextStatusEligible\(\(row as JsonRecord\)\.match_status\)/);
  assert.match(block, /trusted:metadata->tmdbValidation->>valid/);
  assert.match(block, /\.eq\("item_type", itemType\)/);
  assert.match(block, /loc_overview:metadata->i18n->\$\{lang\}->>overview/);
  assert.match(block, /if \(resolvedOverview && \(cat\.localizedOverview \|\| !existingOverview\)\)/);
});

test('zero external budgets still reuse provider and TMDB caches for new accounts', () => {
  const src = read('supabase/functions/_shared/vod-title-projection.ts');
  const vodStart = src.indexOf('async function loadVodInfoIds(');
  const vodEnd = src.indexOf('async function fetchVodInfo(', vodStart);
  const vodBlock = src.slice(vodStart, vodEnd);
  const validationStart = src.indexOf('async function validateProviderTmdbIds(');
  const validationEnd = src.indexOf('// TMDB `translations`', validationStart);
  const validationBlock = src.slice(validationStart, validationEnd);

  assert.doesNotMatch(vodBlock, /if \(limit <= 0\) return result/);
  assert.match(vodBlock, /\.slice\(0, REUSE_SCAN_CAP\)/);
  assert.match(vodBlock, /const toFetch = limit > 0 \? unresolved\.slice\(0, limit\) : \[\]/);
  assert.doesNotMatch(validationBlock, /if \(limit <= 0\) return validations/);
  assert.match(validationBlock, /if \(toFetch\.length > limit\) toFetch = toFetch\.slice\(0, limit\)/);
});

test('future unscanned provider catalogues keep their own synopsis as a fallback', () => {
  const xtream = read('supabase/functions/_shared/xtream-sync.ts');
  const projection = read('supabase/functions/_shared/vod-title-projection.ts');
  const catalog = read('supabase/functions/norva-catalog/index.ts');

  assert.match(xtream, /const providerOverview = itemType === "movie" \|\| itemType === "series"/);
  assert.match(xtream, /boundedProviderOverview\(item\.plot, item\.description, item\.overview, item\.desc\)/);
  assert.match(xtream, /overview: providerOverview/);
  assert.match(projection, /const providerOverview = boundedProviderOverview\(/);
  assert.match(projection, /categoryName: row\.subtitle \|\| metadata\.categoryName,\s*overview: providerOverview/);
  assert.match(catalog, /const variantMetadata = recordOrEmpty\(defaultVariant\.metadata\)/);
  assert.match(catalog, /boundedProviderOverview\(\s*variantMetadata\.overview/);
  assert.match(catalog, /Promote the compact metadata field to the response/);
  for (const src of [xtream, projection, catalog]) {
    assert.match(src, /return text\.slice\(0, 4000\)/);
    assert.match(src, /no \(\?:description\|overview\|plot\)/);
  }
});

test('weak provider identities never receive cross-account synopsis text', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  const start = src.indexOf('function catalogTextStatusEligible(');
  const end = src.indexOf('async function attachMediaLanguages(', start);
  const block = src.slice(start, end);
  assert.match(block, /"provider_verified", "matched", "manual"/);
  assert.doesNotMatch(block, /"provider_unverified"/);
  assert.doesNotMatch(block, /"weak"/);
});

test('cross-account TMDB cache reuse revalidates the current title and year', () => {
  const src = read('supabase/functions/_shared/vod-title-projection.ts');
  const validationStart = src.indexOf('async function validateProviderTmdbIds(');
  const validationEnd = src.indexOf('// TMDB `translations`', validationStart);
  const block = src.slice(validationStart, validationEnd);

  assert.match(block, /\.select\("provider_tmdb_id, title, release_year, poster_url, backdrop_url, metadata"\)/);
  assert.match(block, /matchCatalogValidationCandidate\(candidate, r as JsonRecord, md, tv\)/);
  assert.match(block, /if \(!reuseMatch\) continue/);
  assert.match(block, /Math\.abs\(Number\(candidate\.year\) - Number\(cachedYear\)\) > 1/);
  assert.match(block, /best\.confidence < 0\.58/);
  assert.match(block, /reason: "reused_from_catalog_title_year_match"/);
});

test('live TMDB lookup fills only an empty movie or series fiche synopsis', () => {
  const edge = read('supabase/functions/norva-catalog/index.ts');
  assert.match(edge, /overview: stringOrNull\(data\.overview\)/);

  for (const file of ['public/js/pages/MoviesPage.js', 'public/js/pages/SeriesPage.js']) {
    const src = read(file);
    assert.match(src, /const liveOverview = String\(meta\.overview \|\| ''\)\.trim\(\)/);
    assert.match(src, /plotEl\.textContent === 'No summary available yet\.'/);
    assert.match(src, /plotEl\.textContent = liveOverview/);
  }
});
