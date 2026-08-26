'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = fs
  .readFileSync(path.join(ROOT, 'supabase/functions/norva-catalog/index.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

function sourceBetween(startMarker, endMarker) {
  const start = CATALOG.indexOf(startMarker);
  const end = CATALOG.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source end marker: ${endMarker}`);
  return CATALOG.slice(start, end);
}

test('home rails pass the request through and place liked recommendations before watched', () => {
  assert.match(
    CATALOG,
    /jsonCached\(req,\s*sanitizeCatalogMediaPayload\(await listHomeRails\(req,\s*url,\s*userId\)\),\s*60\)/,
  );

  const home = sourceBetween(
    'async function listHomeRails(',
    '\n// Netflix-style genre rails:',
  );
  assert.match(home, /async function listHomeRails\(req: Request, url: URL, userId: string\)/);
  assert.match(home, /resolveCatalogProfileId\(req, userId\)/);

  const displayOrder = home.slice(home.indexOf('const rails:'));
  assert.ok(
    displayOrder.indexOf('likedRail,') < displayOrder.indexOf('watchedRail ?? popularMovies'),
    'Because You Liked must render before Because You Watched',
  );

  const cache = sourceBetween(
    'function jsonCached(',
    '\nfunction corsHeaders(',
  );
  assert.match(cache, /private, no-store, max-age=0/);
  assert.doesNotMatch(cache, /stale-while-revalidate/);
  assert.match(cache, /"Vary": "Origin, Authorization, x-norva-profile-id"/);
  assert.match(home, /optionalRail\("because_you_liked"/);
  assert.match(home, /optionalRail\("because_you_watched"/);
  assert.match(home, /const profilePromise = resolveCatalogProfileId\(req, userId\)/);
  assert.match(home, /const candidatePromises = new Map/);
});

test('catalog profile resolution validates ownership, plan locks and otherwise uses the default profile', () => {
  const resolver = sourceBetween(
    'function activeCatalogProfileIds(',
    '\nasync function listHomeRails(',
  );

  assert.match(resolver, /req\.headers\.get\("x-norva-profile-id"\)/);
  assert.match(
    resolver,
    /\.select\("id,is_default,created_at"\)\s*\.eq\("user_id", userId\)/,
  );
  assert.match(resolver, /profiles\.find\(\(profile\) => profile\.id === requestedProfileId\)/);
  assert.match(resolver, /getEntitlementDecision\(db, userId, \{ autoStartTrial: false \}\)/);
  assert.match(resolver, /limitNumber\(decision\.limits, "profiles", 1\)/);
  assert.match(resolver, /activeIds\.has\(requestedProfileId\)/);
  assert.match(
    resolver,
    /\.eq\("user_id", userId\)\s*\.order\("is_default", \{ ascending: false \}\)\s*\.order\("sort_order", \{ ascending: true \}\)\s*\.limit\(1\)/,
  );
});

test('liked rail uses the latest explicit like and excludes every explicit rating signal', () => {
  const liked = sourceBetween(
    'async function listBecauseYouLikedRail(',
    '\nasync function listBecauseYouWatchedRail(',
  );
  const exclusions = sourceBetween(
    'async function listRatedCandidateTitleIds(',
    '\nasync function listBecauseYouLikedRail(',
  );

  assert.match(liked, /\.from\("cloud_title_ratings"\)/);
  assert.match(liked, /\.eq\("user_id", userId\)\s*\.eq\("profile_id", profileId\)/);
  assert.match(liked, /\.eq\("rating", 1\)/);
  assert.match(liked, /\.order\("updated_at", \{ ascending: false \}\)/);
  assert.match(liked, /\.limit\(24\)/);
  assert.match(liked, /for \(const like of \(likes \?\? \[\]\)/);
  assert.match(liked, /if \(!candidateAnchor \|\| !titleGenres\(candidateAnchor\)\.length\) continue/);
  assert.match(liked, /listRatedCandidateTitleIds\(/);
  assert.match(exclusions, /\.in\("rating", \[-1, 1\]\)/);
  assert.match(exclusions, /index \+= 100/);
});

test('liked candidate ranking keeps only unrated genre matches and reuses watched-style ordering', () => {
  const rankSource = sourceBetween(
    'function rankBecauseYouLikedCandidates(',
    '\nasync function listRatedCandidateTitleIds(',
  )
    .replace(/:\s*JsonRecord\[\]/g, '')
    .replace(/:\s*JsonRecord/g, '')
    .replace(/:\s*Set<string>/g, '')
    .replace(/:\s*number/g, '');

  const rank = vm.runInNewContext(`(${rankSource})`, {
    titleGenres: (title) => title.genres || [],
    sameGenre: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
    titleTmdb: (title) => title.tmdb || {},
    numberOr: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  });

  const anchor = { id: 'anchor', genres: ['Drama', 'Mystery'] };
  const candidates = [
    { id: 'anchor', genres: ['Drama', 'Mystery'], tmdb: { vote_average: 10 }, synced_at: '2026-07-28' },
    { id: 'disliked', genres: ['Drama'], tmdb: { vote_average: 10 }, synced_at: '2026-07-28' },
    { id: 'liked-before', genres: ['Drama'], tmdb: { vote_average: 9.8 }, synced_at: '2026-07-28' },
    { id: 'unrelated', genres: ['Action'], tmdb: { vote_average: 10 }, synced_at: '2026-07-28' },
    { id: 'lower-match', genres: ['Drama'], tmdb: { vote_average: 7.1 }, synced_at: '2026-07-28' },
    { id: 'best-match', genres: ['Drama', 'Mystery'], tmdb: { vote_average: 8.7 }, synced_at: '2026-07-20' },
  ];

  const result = rank(
    candidates,
    anchor,
    new Set(['anchor', 'disliked', 'liked-before']),
    10,
  );

  assert.deepEqual(
    Array.from(result, (row) => row.id),
    ['best-match', 'lower-match'],
  );
});

test('liked rail reuses the overlaid playable candidate pool and anchor-specific copy', () => {
  const liked = sourceBetween(
    'async function listBecauseYouLikedRail(',
    '\nasync function listBecauseYouWatchedRail(',
  );

  assert.match(liked, /const pool = await options\.candidatesFor\(itemType\)/);
  assert.match(liked, /const candidates = pool\.titles/);
  assert.match(liked, /pool\.variantsByTitle\.get\(String\(row\.id\)\) \?\? \[\]\)\.length > 0/);
  assert.match(liked, /title: anchorName \? `Because You Liked \$\{anchorName\}` : "Because You Liked"/);
  assert.match(liked, /kind: "because_you_liked"/);
  assert.match(liked, /titleRailItem\(row, pool\.variantsByTitle\.get\(String\(row\.id\)\) \?\? \[\], options\.lang\)/);
});

test('watched recommendations are scoped to the active profile', () => {
  const watched = sourceBetween(
    'async function listBecauseYouWatchedRail(',
    '\nasync function resolveWatchedTitle(',
  );

  assert.match(watched, /profileId: string \| null/);
  assert.match(watched, /if \(!profileId\) return null/);
  assert.match(
    watched,
    /\.eq\("user_id", userId\)\s*\.eq\("profile_id", profileId\)\s*\.in\("item_type", itemTypes\)/,
  );
});
