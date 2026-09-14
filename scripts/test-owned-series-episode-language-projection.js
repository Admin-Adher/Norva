#!/usr/bin/env node
'use strict';
// Explicitly opt in to a disposable, network-isolated PostgreSQL container.
// No production tables/data are loaded. Real dependency function definitions
// are extracted from committed migrations; the schema is a minimal harness.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const host = process.argv[2];
const container = process.argv[3];
if (!host || !/^norva-language-corrections-proof-[0-9]{8}$/.test(container || '')) {
  throw new Error('Usage: node scripts/test-owned-series-episode-language-projection.js SSH_HOST norva-language-corrections-proof-YYYYMMDD');
}
const database = 'norva_series_episode_projection_test_20260914';
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const run = (db, sql) => {
  const out = cp.spawnSync('ssh', [host, 'docker', 'exec', '-i', container, 'psql', '-h', '/tmp', '-U', 'postgres', '-d', db, '-X', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 });
  if (out.status !== 0) throw new Error(`Disposable SQL failed (${out.status}): ${out.stderr}\n${out.stdout}`);
  process.stdout.write(out.stdout);
};
const inspect = cp.spawnSync('ssh', [host, 'docker', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', container], { encoding: 'utf8' });
if (inspect.status !== 0 || inspect.stdout.trim() !== 'none') throw new Error('Refuse non-isolated database container');
const exists = cp.spawnSync('ssh', [host, 'docker', 'exec', '-i', container, 'psql', '-h', '/tmp', '-U', 'postgres', '-d', 'postgres', '-X', '-At', '-c', `"select count(*) from pg_database where datname='${database}'"`], { encoding: 'utf8' });
if (exists.status !== 0) throw new Error(exists.stderr);
if (exists.stdout.trim() !== '0') throw new Error('Dedicated fixture database already exists; refuse overwrite. Use a fresh proof container.');
run('postgres', `create database ${database};`);
run(database, read('supabase/tests/fixtures/owned_series_episode_language_minimal_schema.sql'));

const extract = (migration, name) => {
  const source = read(`supabase/migrations/${migration}`);
  const re = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`, 'i');
  const match = source.match(re);
  if (!match) throw new Error(`Missing real dependency ${name}`);
  return match[0];
};
run(database, [
  ['20260910184900_catalog_observed_language_aliases.sql', 'norva_canonical_language_code'],
  ['20260830153000_catalog_language_canonicalization_v1.sql', 'cloud_file_track_languages'],
  ['20260719170000_variant_file_audio_crawler.sql', 'catalog_audio_track_indexes'],
  ['20260816105918_async_vod_language_validation_jobs.sql', 'vod_language_profile_audio_indices'],
  ['20260816105918_async_vod_language_validation_jobs.sql', 'vod_language_profile_file_size_bytes'],
  ['20260909190753_selection_audio_analysis_queue.sql', 'selection_audio_tracks_complete'],
  ['20260909095957_selection_reenrollment_identity.sql', 'norva_selection_source_identity_valid']
].map(([migration, name]) => extract(migration, name)).join('\n'));
run(database, read('supabase/migrations/20260914001822_owned_series_episode_language_projection.sql'));
run(database, read('supabase/tests/owned_series_episode_language_projection.sql'));
