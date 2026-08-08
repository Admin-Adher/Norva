-- Bound the P0 accountable-owner legal/tax acceptance to the same 90-day
-- validity window enforced by the release-evidence validator. Approval
-- packages remain append-only; an overlong historical package therefore makes
-- this migration fail closed instead of silently rewriting its evidence.

alter table affiliate_private.affiliate_approval_packages
  add constraint affiliate_approval_packages_owner_review_validity
  check (
    gate_key <> 'legal_and_tax_approved'
    or expires_at <= approved_at + interval '90 days'
  ) not valid;

alter table affiliate_private.affiliate_approval_packages
  validate constraint affiliate_approval_packages_owner_review_validity;

comment on constraint affiliate_approval_packages_owner_review_validity
  on affiliate_private.affiliate_approval_packages is
  'P0 accountable-owner legal/tax risk acceptance expires no later than 90 days after its immutable approval timestamp.';
