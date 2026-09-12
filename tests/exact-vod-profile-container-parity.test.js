'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20260912154000_exact_vod_profile_container_parity.sql'), 'utf8');
const operator = fs.readFileSync(path.join(__dirname, '../ops/hetzner/scripts/proof-deploy-exact-profile-parity-20260912.py'), 'utf8');

test('profile parity replaces only the current format allowlist and preserves exact-file guards', () => {
  assert.match(migration, /pg_get_functiondef\(target\)/);
  assert.match(migration, /EXECUTE replace\(definition, old_formats, new_formats\)/);
  assert.match(migration, /Exact VOD profile guard drifted/);
  assert.match(migration, /vod_language_profile_file_size_bytes\(p_profile\) is not null/);
  assert.match(migration, /vod_language_profile_audio_indices\(p_profile\)/);
  assert.match(migration, /IF position\(new_formats IN definition\) > 0 THEN\s+RETURN/);
  const formats = migration.match(/\$new\$(.*?)\$new\$/)[1];
  for (const name of ['ts', 'mpegts', 'm4v', 'movmp4m4a3gp3g2mj2']) assert.ok(formats.includes(`'${name}'`));
  for (const name of ['hls', 'dash', 'mpegtslive', 'mp4hls']) assert.ok(!formats.includes(`'${name}'`));
  assert.doesNotMatch(migration, /(?:INSERT INTO|DELETE FROM|UPDATE public\.|ALTER TABLE|GRANT|REVOKE)/i);
});

test('deployment requires isolated SQL cases, exact migration hashes, rollback and the idle release guard', () => {
  assert.match(operator, /base\.proof = proof/);
  assert.match(operator, /--network', 'none'/);
  assert.match(operator, /before\.replace\(OLD, NEW\)/);
  assert.match(operator, /negativeCases/);
  assert.match(operator, /deploy\(sys\.argv\[2\]\)/);
  assert.match(operator, /rollback\.private\.json/);
  assert.match(operator, /sha\(migration\) == evidence\['migrationSha256'\]/);
  assert.match(operator, /live\.op\.base\.previous\.d\.idle\(\)/);
});
