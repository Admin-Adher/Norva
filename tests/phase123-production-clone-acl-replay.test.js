const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const script = fs.readFileSync(path.join(
  __dirname,
  '..',
  'ops',
  'hetzner',
  'scripts',
  'run_phase123_production_clone_rehearsal.sh',
), 'utf8');

test('production clone freezes API ACLs before pg_dump and replays after restore', () => {
  const snapshot = script.indexOf('production-api-acl-replay.sql');
  const dump = script.indexOf('DUMP_BEGIN');
  const restore = script.indexOf('docker exec -i "$TARGET_CONTAINER" pg_restore', dump);
  const replay = script.indexOf('ACL_REPLAY_COMPLETE');
  assert.ok(snapshot >= 0 && snapshot < dump);
  assert.ok(restore > dump && replay > restore);
});

test('ACL replay revokes inherited bootstrap defaults before exact grants', () => {
  assert.match(script, /revoke all on table %I\.%I from public,anon,authenticated,service_role/);
  assert.match(script, /revoke all on sequence %I\.%I from public,anon,authenticated,service_role/);
  assert.match(script, /revoke all on %s %I\.%I\(%s\) from public,anon,authenticated,service_role/);
  assert.match(script, /pg_catalog\.aclexplode/);
  assert.match(script, /with grant option/);
  assert.match(script, /docker exec -i "\$PRODUCTION_CONTAINER" psql[\s\S]*production-api-acl-replay\.sql/);
});

test('clone acceptance requires a canonical post-replay ACL diff', () => {
  assert.match(script, /production-api-acl\.tsv/);
  assert.match(script, /clone-api-acl\.tsv/);
  assert.match(script, /api-acl-diff\.txt/);
  assert.match(script, /clone API ACLs differ from production/);
});
