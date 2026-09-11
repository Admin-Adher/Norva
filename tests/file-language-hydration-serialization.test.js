'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sql = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20260911024716_serialize_exact_file_language_hydration.sql'), 'utf8');
const routines = sql.split('CREATE OR REPLACE FUNCTION public.').slice(1);

test('all four existing movie/episode hydration signatures preserve their security attributes', () => {
  assert.equal(routines.length, 4);
  for (const routine of routines) {
    assert.match(routine, /SECURITY DEFINER/);
    assert.match(routine, /SET search_path TO/);
    assert.doesNotMatch(routine, /grant|disable trigger|row_security\s*=\s*off/i);
    assert.match(routine, /p_user_id uuid, p_source_id uuid/);
  }
  assert.match(sql, /SET LOCAL lock_timeout = '3s'/);
  assert.match(sql, /SET LOCAL statement_timeout = '30s'/);
});

test('movies lock an owner-scoped deterministic cache set before reading evidence or writing projections', () => {
  const movies = routines.filter(r => r.startsWith('hydrate_cloud_title_file_languages'));
  assert.equal(movies.length, 2);
  for (const routine of movies) {
    const locked = routine.indexOf('for share of cache');
    assert.ok(locked > 0 && locked < routine.indexOf('for v_file in'));
    assert.ok(locked < routine.indexOf('insert into public.cloud_title_file_language_observations'));
    assert.match(routine.slice(0, locked), /cache.server_host=v_cache_key and cache.item_type='movie'/);
    assert.match(routine.slice(0, locked), /variant.user_id=p_user_id and variant.source_id=p_source_id/);
    assert.match(routine.slice(0, locked), /order by cache.external_id/);
    assert.match(routine.slice(locked), /variant.external_id=any\(v_hydration_file_ids\)/);
    assert.match(routine, /catalog_source_file_cache_key\(p_source_id,\s*p_user_id\)/);
  }
});

test('episodes acquire provider advisory locks before exact cache locks and never read an unlocked new file', () => {
  const episodes = routines.filter(r => r.startsWith('hydrate_catalog_episode_file_tracks'));
  assert.equal(episodes.length, 2);
  for (const routine of episodes) {
    const advisory = routine.indexOf('pg_advisory_xact_lock');
    const cacheLock = routine.indexOf('for share of cache');
    assert.ok(advisory > 0 && cacheLock > advisory && cacheLock < routine.indexOf('for v_episode in'));
    assert.match(routine, /array_agg\(provider_id order by provider_id\)/);
    assert.match(routine, /catalog-series-episode-provider:/);
    assert.match(routine, /order by cache.server_host,cache.external_id/);
    assert.match(routine, /cache.server_host=any\(v_hydration_provider_ids\)/);
    assert.match(routine.slice(cacheLock), /membership.episode_id\)=any\(v_hydration_file_ids\)/);
  }
});

test('fenced signatures revalidate generation and all four revisions after waiting for the cache', () => {
  for (const routine of routines) {
    const fenced = routine.split('RETURNS')[0].includes('p_generation_id uuid');
    const lock = routine.indexOf('for share of cache');
    if (fenced) {
      assert.match(routine.slice(lock), /norva_set_catalog_delete_proof\(\s*p_source_id,p_user_id,p_generation_id,p_head_revision,p_config_revision,\s*p_source_visibility_epoch,p_user_visibility_epoch/);
      assert.match(routine.slice(0, lock), /generation_id=p_generation_id/);
    }
  }
});
