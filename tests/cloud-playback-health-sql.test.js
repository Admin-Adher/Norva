const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch (error) { if (process.env.NORVA_REQUIRE_SELECTION_SQL === '1') throw error; }
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('playback health PostgreSQL ownership, revision, ordering and event projection', { skip: !PGlite }, async () => {
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(read('tests/fixtures/cloud-playback-health-schema.sql'));
    await db.exec(read('supabase/migrations/20261001070000_cloud_playback_health.sql'));
    await db.exec(read('tests/fixtures/cloud-playback-health-assert.sql'));
  } finally { await db.close(); }
});
