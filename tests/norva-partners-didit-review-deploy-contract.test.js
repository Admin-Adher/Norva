const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('physical rehearsal proves the Didit review continuation from the exact baseline', () => {
  const rehearsal = read('ops/hetzner/backup/rehearse-partners-physical.sh');

  assert.match(rehearsal, /readonly BASELINE_CONTRACT="5347483"/);
  assert.match(
    rehearsal,
    /readonly TARGET_MIGRATION="supabase\/migrations\/20260810201500_partners_didit_review_recovery\.sql"/,
  );
  assert.match(rehearsal, /DIDIT_REVIEW_RECOVERY_MARKER_COMPLETE="1"/);
  assert.match(rehearsal, /DIDIT_REVIEW_RECOVERY_MARKER_PENDING="0"/);
  assert.match(rehearsal, /capture_didit_review_recovery_marker\(\)/);
  assert.match(rehearsal, /data\.updated:%/);
  assert.match(rehearsal, /v_session\.status <> ''in_review''/);
  assert.match(rehearsal, /p_event_created_at <= v_session\.last_event_created_at/);
  assert.match(rehearsal, /--single-transaction/);
  assert.match(rehearsal, /DIDIT_REVIEW_RECOVERY_MARKER_PENDING/);
  assert.match(rehearsal, /DIDIT_REVIEW_RECOVERY_MARKER_COMPLETE/);
});

test('restore verifier retains the fail-closed Didit manual-review contract', () => {
  const verifier = read('ops/hetzner/backup/verify-partners-restore.sql');

  assert.match(
    verifier,
    /partners_service_kyc_certification_webhook_apply_and_enqueue_pu/,
  );
  assert.match(verifier, /data\.updated:%/);
  assert.match(verifier, /v_session\.status <> ''in_review''/);
  assert.match(verifier, /p_event_created_at <= v_session\.last_event_created_at/);
  assert.match(verifier, /fail-closed manual-review continuation/);
});
