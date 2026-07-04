'use strict';
// Genre taxonomy parity lock.
//
// The curated genre classifier exists in THREE places that MUST agree:
//   1. supabase/functions/_shared/genre-taxonomy.ts   (edge, authoritative)
//   2. public/js/utils/GenreTaxonomy.js               (browser mirror, local mode)
//   3. public.norva_classify_buckets(...) in Postgres (SQL port, migration
//      20260704160000) — the one that fills cloud_titles.genre_buckets, which the
//      Movies/Series rails + "See all" grids + genre-picker counts all filter on.
//
// This test loads the browser mirror and locks its classifyTitle() output on
// representative fixtures. If a taxonomy change makes a fixture fail, update the
// TS shared module AND the SQL port together, then re-backfill genre_buckets — or
// the picker count (SQL) and the grid (SQL) will silently drift from local mode (JS).
//
// The SQL port was validated against live data: per-bucket counts from
// norva_classify_buckets equal the edge summary (e.g. Adventure = 351 for the
// reference account), and the fixtures below were confirmed identical in SQL.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTaxonomy() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/utils/GenreTaxonomy.js'), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'GenreTaxonomy.js' });
  return sandbox.window.GenreTaxonomy;
}

test('browser taxonomy exposes classifyTitle', () => {
  const T = loadTaxonomy();
  assert.ok(T && typeof T.classifyTitle === 'function', 'GenreTaxonomy.classifyTitle missing');
});

test('classifyTitle fixtures match the SQL port (norva_classify_buckets)', () => {
  const T = loadTaxonomy();
  // Array.from() re-homes the vm-context array into this realm (deepStrictEqual
  // compares prototypes, and a cross-realm array otherwise never matches).
  const eq = (cat, genres, expected, msg) =>
    assert.deepStrictEqual(Array.from(T.classifyTitle(cat, genres)), expected, msg || `${cat} / ${JSON.stringify(genres)}`);

  // TMDB payload → bucket
  eq('EN - ADVENTURE', null, ['aventure'], 'category keyword adventure');
  eq(null, ['Action', 'Adventure'], ['action', 'aventure'], 'payload action+adventure');
  eq('whatever', ['Horror'], ['horreur'], 'payload horror');
  eq(null, ['Science Fiction'], ['scifi'], 'sci-fi payload');
  eq(null, ['War'], ['action'], 'war maps to action');

  // Category-keyword priority: fantastique OUTRANKS aventure → scifi, not aventure.
  eq('FR - FANTASTIQUE AVENTURE', null, ['scifi'], 'fantastique beats aventure');

  // Arabic script / prefix
  eq('AR MOVIES', ['Action'], ['action', 'arabe'], 'AR prefix + action payload');
  eq('AR: MOVIES Dubbed أفلام مدبلجة', ['Action', 'Adventure'], ['action', 'aventure', 'arabe'], 'arabic full');

  // Animation kids vs adult
  eq('Séries ANIMÉES POUR ADULTES', null, ['animation_adult'], 'adult animation');
  eq('DESSINS ANIMES ENFANTS', null, ['animation_kids'], 'kids animation');
  eq(null, ['Animation'], ['animation_kids'], 'animation payload defaults to kids');

  // K-Drama picks up both the drama keyword and the kdrama marker
  eq('K-DRAMA', null, ['drame', 'kdrama'], 'k-drama');

  // Multi-membership, display order preserved
  eq(null, ['Comedy', 'Drama', 'Science Fiction'], ['comedie', 'drame', 'scifi'], 'multi ordered');

  // Unclassifiable → autres
  eq('DE - FILME', null, ['autres'], 'unclassifiable provider category');
});
