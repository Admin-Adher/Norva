---
content_id: "NVB-778"
title: "Move Media Credentials Between Password Managers Safely"
seo_title: "Move Media Credentials Between Password Managers"
meta_description: "Migrate media credentials by securing both managers, minimizing export exposure, validating boundaries and recovery, then retiring old copies deliberately."
slug: "migrate-media-credentials-password-manager"
canonical_url: "https://norva.tv/blog/migrate-media-credentials-password-manager/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "credential-migration-guide"
topic_cluster: "Account Security"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can I move media credentials between password managers safely?"
supporting_questions:
  - "How should exported credential files be protected?"
  - "When can the old password manager be retired?"
audience:
  - "Norva users changing password managers"
  - "Household administrators migrating shared media credentials"
author:
  name: ""
  profile_url: ""
human_review:
  required: true
  status: "pending"
  reviewer_name: ""
  reviewer_role: ""
  reviewed_at: null
  decision: ""
  notes: ""
product_claims:
  verified: false
  verified_by: ""
  verified_at: null
  source_of_truth: "https://norva.tv/privacy"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A password-manager migration protects both vaults, minimizes plaintext export exposure, validates account boundaries and recovery, and retires old copies only after confirmation."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: false
parent_pillar: "/blog/media-player-security-checklist/"
related_articles:
  - "/blog/password-manager-setup-media-household/"
  - "/blog/unique-password-lifecycle-media-account/"
  - "/blog/separate-account-and-source-credentials/"
cta:
  label: "Review Norva's Privacy Information"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.cisa.gov/secure-our-world"
  - "https://www.nist.gov/cybersecurity-and-privacy/how-do-i-create-good-password"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "password manager migration reconciliation sheet"
  summary: "A reconciliation sheet compares record counts, boundary ownership, official destinations, recovery notes, sharing rules, attachments, import results, export-file handling, and old-vault retirement."
  methodology: "The administrator follows both vendors' current instructions, uses a trusted updated device, limits export lifetime, verifies representative records without exposing values, and delays retirement until recovery is tested."
  asset_urls: []
---

# Move Media Credentials Between Password Managers Safely

> **In short:** Secure both password managers and their recovery methods, inventory the records and sharing rules to move, and follow each vendor's current official export and import instructions. Use a trusted updated device, keep any unencrypted export offline and short-lived, validate imported records without exposing values, test recovery, and remove temporary files. Keep the old vault available until counts, ownership, access, and backups are confirmed, then retire it deliberately.

A migration can briefly place many otherwise separated credentials into one file or clipboard. The goal is to reduce that exposure window while preserving unique passwords, official destinations, notes, and household permissions.

## Inventory boundaries, not just entries

List the Norva account, recovery email, device-platform accounts, password-manager account, and every compatible source the owner is authorized to use. Use the [credential-separation guide](/blog/separate-account-and-source-credentials/) to confirm that each boundary has its own record and unique password.

Count folders, shared collections, attachments, passkeys or other supported item types, recovery references, and archived records. Import capabilities vary, so consult both vendors' current documentation before assuming every field transfers.

## Secure the old and new managers

Use unique account credentials and review recovery, devices, sessions, and sharing on both sides. Install or open each manager from its known official destination. Update the operating system and applications before handling a bulk export.

The [household password-manager setup](/blog/password-manager-setup-media-household/) helps distinguish administrators from ordinary viewers. Do not grant everyone access merely to simplify migration.

## Choose the least-exposing transfer method

Prefer a vendor-supported direct or encrypted migration path when current documentation clearly supports it. If an export file is required, determine whether it is encrypted. Many common interchange formats can expose secrets as readable text; treat the file as highly sensitive.

Use a trusted personal device, avoid public or borrowed computers, close unrelated applications, and do not upload the export to email, chat, generic cloud storage, or a conversion website. Store it only as long as required in a location controlled by the authorized administrator.

## Import once and reconcile carefully

Follow the new manager's official import flow. Compare total counts and categories, then inspect representative records for usernames, official URLs, notes, attachments, and sharing membership. Do not display passwords during a screen share or copy them into the reconciliation sheet.

Duplicate imports can create ambiguity. Identify which record is authoritative before deleting anything. Verify that Norva and source records remain separate and that labels do not reveal secret or personal information.

## Test access and recovery without overexposure

Test a small selection of official sign-in destinations from a trusted device. Avoid signing out every household device at once. Confirm that authorized administrators can recover the new manager under its current process without placing recovery secrets in shared notes.

Use the [unique-password lifecycle guide](/blog/unique-password-lifecycle-media-account/) if the migration reveals reused, weak, or previously exposed values. Migration alone is not a reason to rotate every healthy unique password, but exposure of the export may be.

## Destroy temporary export material

After successful reconciliation and according to the operating system and vendor guidance, remove the export and temporary copies from downloads, desktop, recent-files locations, removable media, backups, and recycle or trash areas. Recognize that deletion behavior varies by device and storage system.

If an unencrypted export entered an unauthorized service or device, treat every credential it contained as potentially exposed and begin incident response.

## Retire the old vault deliberately

Keep the old manager available until imported content, recovery, sharing, and necessary records are confirmed. Then revoke household shares, remove old devices or sessions, handle billing, export-retention, and account deletion under the old vendor's current instructions.

Record final status without recording any secret. A cancelled subscription is not necessarily a deleted account, and an app uninstall is not proof that cloud-held data was removed.

## Original evidence: migration reconciliation sheet

| Control | Old manager | New manager | Difference | Action | Status |
| --- | --- | --- | --- | --- | --- |
| Record and folder counts |  |  |  | Reconcile |  |
| Norva/source separation |  |  |  | Correct labels |  |
| Sharing roles |  |  |  | Apply least access |  |
| Recovery tested |  |  |  | Verify officially |  |
| Export copies | Locations only | Removed where possible |  | Confirm handling |  |
| Old vault retirement | Planned | Active |  | Close deliberately |  |

## Common mistakes and limitations

- Emailing an unencrypted export to oneself.
- Assuming every field and attachment imported.
- Merging Norva and source credentials into one record.
- Repeating the import and leaving ambiguous duplicates.
- Deleting the old vault before testing recovery.
- Treating an uninstall as account deletion.
- Recording actual secrets in the migration sheet.

## Frequently asked questions

### Should I change every password during migration?

Not automatically. Preserve healthy unique passwords, but replace reused or exposed values and respond if a plaintext export escaped authorized control.

### Can I keep the export as a backup?

A readable bulk export creates concentrated risk. Use the new manager's documented backup and recovery options instead of retaining an unsafe file indefinitely.

### When is it safe to close the old manager?

After counts, representative records, sharing, recovery, temporary-file handling, and authorized access are verified and the old vendor's closure steps are complete.

## Your next step

[Review Norva's Privacy Information](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
- [NIST: How do I create a good password?](https://www.nist.gov/cybersecurity-and-privacy/how-do-i-create-good-password)
