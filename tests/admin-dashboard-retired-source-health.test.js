'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations',
  '20260909131402_admin_ignore_retired_selection_sources.sql'), 'utf8');

test('retired-source exclusion requires a disabled Norva-managed source with an explicit dated marker', () => {
  assert.match(migration, /s\.enabled is false/);
  assert.match(migration, /s\.config_hint->>'managedBy' = 'norva-cloud'/);
  assert.match(migration, /jsonb_typeof\(s\.config_hint#>'\{selectionGeneralFeedRetirement,at\}'\) = 'string'/);
  assert.match(migration, /nullif\(btrim\(s\.config_hint#>>'\{selectionGeneralFeedRetirement,at\}'\), ''\) is not null/);
  assert.match(migration, /v_guard text := \$guard\$not coalesce\(/);
  assert.doesNotMatch(migration, /delete\s+from|update\s+(?:public\.)?cloud_|grant\s+|revoke\s+/i);
});

test('the same exclusion guards dashboard rows, aggregate counts and metric snapshots with drift checks', () => {
  assert.match(migration, /public\.refresh_admin_dashboard\(\)/);
  assert.match(migration, /public\.snapshot_admin_metrics\(\)/);
  assert.match(migration, /coalesce\(mc\.n_ms, 0\) > 0 and coalesce\(vc\.n, 0\) = 0/);
  assert.match(migration, /coalesce\(mc\.n,0\)>0 and coalesce\(vc\.n,0\)=0/);
  assert.match(migration, /cloud_title_variants v2 where v2\.source_id = s\.id/);
  assert.match(migration, /v_old_count = v_patch\.expected_count and v_new_count = 0/);
  assert.match(migration, /v_old_count = 0 and v_new_count = v_patch\.expected_count/);
  assert.match(migration, /raise exception 'unexpected source supervision definition/);
});
