'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase/migrations/20260730093000_security_advisor_hardening.sql',
  ),
  'utf8',
);

test('security hardening relocates extensions and preserves explicit lookup', () => {
  assert.match(migration, /alter extension pg_trgm set schema extensions/);
  assert.match(migration, /alter extension unaccent set schema extensions/);
  assert.match(migration, /alter extension pgstattuple set schema extensions/);
  assert.match(migration, /drop extension http restrict/);
  assert.match(
    migration,
    /create extension http with schema extensions version %L/,
  );
  assert.match(
    migration,
    /replace\([\s\S]*'public\.unaccent'[\s\S]*'extensions\.unaccent'/,
  );
  assert.match(
    migration,
    /alter function public\.search_media_items\([\s\S]*set search_path = pg_catalog, public, extensions/,
  );
});

test('self-host-only advisor drift is hardened without breaking blank replay', () => {
  assert.match(
    migration,
    /to_regprocedure\('public\._norva_probe\(text,jsonb\)'\)/,
  );
  assert.match(
    migration,
    /historical _norva_probe definition drifted[\s\S]*drop function public\._norva_probe\(text, jsonb\)/,
  );
  assert.match(
    migration,
    /alter view public\.admin_provider_overview[\s\S]*security_invoker = true/,
  );
});

test('every advisor-reported function receives one fixed search path', () => {
  const names = [
    'safe_numeric',
    'cmi_set_sort_cols',
    'safe_bigint',
    'norva_html_escape',
    'catalog_titles_keep_best',
    'catalog_media_items_keep_best',
    'propagate_media_item_years',
    'is_admin',
    'norva_classify_buckets',
    'norva_norm',
    'norva_refresh_posters_from_catalog',
    'list_media_items_deduped',
    'norva_backfill_media_identity',
    'norva_canonicalize_titles_for_user',
    'norva_reconcile_catalog',
    'whitelist_subtitle_candidates',
  ];

  for (const name of names) {
    assert.match(
      migration,
      new RegExp(
        `alter function public\\.${name}\\([\\s\\S]*?set search_path = pg_catalog, public, extensions`,
      ),
      `${name} must have a fixed search_path`,
    );
  }
  assert.doesNotMatch(migration, /set search_path\s*=\s*public\s*;/);
});
