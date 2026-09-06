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

  assert.match(block, /const fullOverlayEnabled = catalogReadEnabled\(\)/);
  assert.match(block, /if \(!fullOverlayEnabled\) \{\s*await applyCatalogTextOverlay\(globalRows, itemType, lang\);/);
  assert.match(block, /applyGenerationCatalogMetadata\(row, lang, fullOverlayEnabled\)/);
  assert.match(src, /Flag OFF must remain equivalent to the legacy thinned cloud_titles payload/);
  assert.match(src, /Permanent safe read path for title text removed by cloud_titles self-thinning/);
});

test('shared text is catalog-validated, item-type scoped, and projected', () => {
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
  assert.match(block, /if \(baseOverview\)/);
  assert.doesNotMatch(block, /row\.(release_year|poster_url|backdrop_url)\s*=/);
});

test('validated TMDB summaries replace provider text with provider fallback when absent', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /stringOrNull\(tmdb\.overview\) \?\? stringOrNull\(metadata\.overview\)/);
  assert.match(src, /stringOrNull\(rowTmdb\.overview\)\s*\?\? stringOrNull\(row\.overview\)/);
  assert.match(src, /preferredTmdbSynopsis\(cat\.localizedOverview, cat\.fallbackOverview, existingOverview\)/);
  assert.match(src, /\?\? stringOrNull\(title\.__catalog_base_overview\)\s*\?\? stringOrNull\(metadata\.overview\)\s*\?\? providerOverview/);
});

test('all title rails forward the requested synopsis language', () => {
  const src = read('supabase/functions/norva-catalog/index.ts');
  assert.match(src, /applyCatalogOverlay\(selectedRows, itemType, lang\)/);
  assert.equal((src.match(/applyCatalogOverlay\(pageRows, itemType, lang\)/g) || []).length, 3);
  assert.match(src, /applyCatalogOverlay\(titles, itemType, lang\)/);
  assert.equal((src.match(/applyCatalogOverlay\(titles, itemType, lang\)/g) || []).length, 3);
  assert.match(src, /listVerifiedTitleCandidatePool\(userId, type, lang\)/);
  assert.match(src, /type TitleCandidatesFor = \(itemType: "movie" \| "series"\)/);
  assert.match(src, /const candidatePromises = new Map<"movie" \| "series", Promise<HomeTitleCandidatePool>>/);
  assert.ok(
    (src.match(/await (?:options\.)?candidatesFor\(itemType\)/g) || []).length >= 3,
    'genre, popular and personalized rails must share the request-scoped candidate pool',
  );
  assert.match(src, /listVerifiedTitleCandidatePool[\s\S]*variantsByTitle/);
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
  assert.match(block, /if \(resolvedOverview\)/);
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
    assert.match(src, /plotEl\.textContent === \(globalThis\.NorvaI18n\?\.t\('[^']+', \{ defaultValue: "No summary available yet\." \}\) \?\? 'No summary available yet\.'\)/);
    assert.match(src, /plotEl\.textContent = liveOverview/);
  }
});
