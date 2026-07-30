'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(
  path.join(root, 'supabase/functions/norva-admin/index.ts'),
  'utf8',
);

test('the existing recovery-aware ops sweep consumes the sanitized Partners snapshot', () => {
  assert.match(admin, /async function readPartnersOpsSnapshot\(\)/);
  assert.match(admin, /\.eq\("key", "partners_enabled"\)/);
  assert.match(admin, /flag\?\.enabled !== true[\s\S]*enabled: false/);
  assert.match(admin, /admin\.rpc\("partners_service_ops_alert_snapshot"\)/);
  assert.match(admin, /payload\.schema_version !== 1 \|\| !Array\.isArray\(payload\.alerts\)/);
  assert.match(admin, /\^\[a-z0-9_\]\{3,64\}\$/);
  assert.match(admin, /Number\.isSafeInteger\(count\) \|\| count < 0/);
});

test('Partners incidents use stable cooldown keys without forwarding private payloads', () => {
  assert.match(admin, /key: "partners_monitoring_unavailable"/);
  assert.match(admin, /key: `partners_\$\{alert\.code\}`/);
  assert.match(admin, /detail: `Norva Partners · \$\{alert\.code\} · \$\{alert\.count\} observation/);
  assert.match(admin, /"partners_monitoring"/);
  assert.doesNotMatch(
    admin.slice(
      admin.indexOf('async function readPartnersOpsSnapshot'),
      admin.indexOf('async function runOpsAlertSweep'),
    ),
    /JSON\.stringify\(data\)|payload\.details|payload\.workers|payload\.kyc_quota/,
  );
});
