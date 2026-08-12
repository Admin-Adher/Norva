const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('physical rehearsal preserves the complete Didit contract while numbering visible referrals', () => {
  const rehearsal = read('ops/hetzner/backup/rehearse-partners-physical.sh');

  assert.match(rehearsal, /readonly BASELINE_CONTRACT="d120672"/);
  assert.match(
    rehearsal,
    /readonly TARGET_MIGRATION="supabase\/migrations\/20260812082001_partners_referral_visible_numbering\.sql"/,
  );
  assert.match(rehearsal, /DIDIT_REVIEW_RECOVERY_MARKER_COMPLETE="1"/);
  assert.match(rehearsal, /DIDIT_REVIEW_RECOVERY_MARKER_PENDING="0"/);
  assert.match(rehearsal, /capture_didit_review_recovery_marker\(\)/);
  assert.match(rehearsal, /DIDIT_SIGNED_REVIEW_GRACE_MARKER_COMPLETE="1"/);
  assert.match(rehearsal, /DIDIT_SIGNED_REVIEW_GRACE_MARKER_PENDING="0"/);
  assert.match(rehearsal, /capture_didit_signed_review_grace_marker\(\)/);
  assert.match(rehearsal, /DIDIT_ORPHAN_PURGE_RECOVERY_MARKER_COMPLETE="1"/);
  assert.match(rehearsal, /DIDIT_ORPHAN_PURGE_RECOVERY_MARKER_PENDING="0"/);
  assert.match(rehearsal, /capture_didit_orphan_purge_recovery_marker\(\)/);
  assert.match(rehearsal, /REFERRAL_VISIBILITY_MARKER_COMPLETE="1"/);
  assert.match(rehearsal, /REFERRAL_VISIBILITY_MARKER_PENDING="0"/);
  assert.match(
    rehearsal,
    /REFERRAL_VISIBILITY_DELETED_ACCOUNT_MARKER_COMPLETE="1"/,
  );
  assert.match(
    rehearsal,
    /REFERRAL_VISIBILITY_DELETED_ACCOUNT_MARKER_PENDING="0"/,
  );
  assert.match(rehearsal, /REFERRAL_VISIBLE_NUMBERING_MARKER_COMPLETE="1"/);
  assert.match(rehearsal, /REFERRAL_VISIBLE_NUMBERING_MARKER_PENDING="0"/);
  assert.match(rehearsal, /capture_referral_visible_numbering_marker\(\)/);
  assert.match(rehearsal, /partners_service_referral_visibility/);
  assert.match(rehearsal, /partners_service_didit_purge_orphans/);
  assert.match(rehearsal, /partners_service_didit_purge_recover/);
  assert.match(rehearsal, /provider_delivered_at/);
  assert.match(rehearsal, /partners_service_didit_cert_review_apply_purge/);
  assert.match(rehearsal, /data\.updated:%/);
  assert.match(rehearsal, /v_session\.status <> ''in_review''/);
  assert.match(rehearsal, /p_event_created_at <= v_session\.last_event_created_at/);
  assert.match(rehearsal, /--single-transaction/);
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
