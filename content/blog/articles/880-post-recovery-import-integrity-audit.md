---
content_id: "NVB-880"
title: "Run an Import Integrity Audit After Recovery"
seo_title: "Import Integrity Audit After Recovery"
meta_description: "Verify integrity after import recovery by comparing counts, categories, samples, versions, artwork, progress, favorites, profiles, devices, and incidents."
slug: "post-recovery-import-integrity-audit"
canonical_url: "https://norva.tv/blog/post-recovery-import-integrity-audit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "post-recovery-integrity-audit"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I verify catalog integrity after fixing an import?"
supporting_questions:
  - "Which counts, categories, items, versions, artwork, progress, favorites, profiles, devices, and incident facts should be checked?"
  - "How can recovery be closed without promising complete correctness?"
audience:
  - "Norva users after import recovery"
  - "Household source administrators"
author: { name: "", profile_url: "" }
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A post-recovery audit compares the original baseline with aggregate counts and a minimal sample of categories, identities, versions, artwork, progress, favorites, profiles, and devices."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/duplicates-after-repeat-import/"
  - "/blog/expected-items-missing-after-sync/"
  - "/blog/progress-reset-after-item-identity-change/"
  - "/blog/favorites-orphaned-after-source-refresh/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "post-recovery import integrity scorecard"
  summary: "A scorecard compares the pre-incident baseline and recovered state across source authorization, counts, categories, item identities, versions, series gaps, artwork, progress, favorites, profiles, devices, and unresolved actions."
  methodology: "The user freezes the recovered context, verifies a privacy-safe sample against the baseline, checks another supported device and profile where relevant, labels pass, difference, unknown, and not applicable, and assigns follow-up."
  asset_urls: []
---

# Run an Import Integrity Audit After Recovery

> **In short:** Do not stop at the first successful import. Freeze the recovered account, profile, source, filters, grouping, device, and application version, then compare the pre-incident baseline with aggregate counts and a small sample of categories, items, versions, series seasons, artwork, progress, favorites, and another supported device. Mark pass, expected difference, unexplained difference, unknown, or not applicable, and assign every unresolved result.

Recovery proves that one blocked path now works. It does not automatically prove the catalog, household state, and every device returned to the intended condition. A dated closure record also makes later catalog changes easier to distinguish clearly from the resolved incident.

## Preserve the recovery event

Record the root symptom, recovery action, actor, authorization, time, device, application version, network, and first successful result. Keep observations separate from the suspected cause. Do not expose credentials or private source addresses.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) provides the original evidence-layer matrix.

## Recreate the baseline context

Use the same account, profile, enabled sources, availability, category, filters, search, sort, grouping, and comparable device where practical. List any intentional changes since the baseline. A different context cannot produce a clean integrity comparison.

## Compare aggregate structure

Record displayed catalog and category counts, category labels, empty or missing categories, and visible series or media-type totals. Classify deltas rather than assuming the earlier number is permanently correct. Source membership may have changed legitimately.

## Check item identity and versions

Select a few privacy-safe samples: one previously missing item, one unaffected control, one duplicate or grouped version, and one series when relevant. Compare source label, title code, year, media type, season, episode, duration, version, and language cues.

The [duplicate comparison](/blog/duplicates-after-repeat-import/) and [missing-item checklist](/blog/expected-items-missing-after-sync/) provide focused branches.

## Check presentation data

For the same samples, record title metadata, description, artwork, category, release year, runtime, and language badges where shown. An image difference should not be treated as media absence. Record stale or partial presentation separately.

## Check progress and favorites carefully

With the expected profile, compare a minimal pre-incident sample of progress, completion, and favorites. Do not export complete history. If an item identity changed, use the [progress identity audit](/blog/progress-reset-after-item-identity-change/) and preserve both cards.

For favorite references, use the [orphaned favorite audit](/blog/favorites-orphaned-after-source-refresh/) before cleanup.

## Check series boundaries

For one affected series, verify season labels, representative first and last episodes, specials, and visible gaps. Avoid renumbering or editing source metadata merely to make the audit pass.

## Compare another supported device

Use the same trusted account, profile, source selection, filters, grouping, and sample close in time. Record device and application versions. A difference on one screen remains an unresolved cross-device result even when the primary device looks correct.

## Verify security and ownership

Confirm source authorization, owner, protected credential state, recovery channels, and any post-incident session revocation. A catalog repair should not leave obsolete administrators, insecure temporary records, or weakened certificate checks.

## Classify every audit row

Use pass, expected source change, unexplained difference, unknown, not applicable, or blocked by missing baseline. Add an owner, evidence, and next review date for every unresolved result. Do not declare full integrity from a small sample; state the audit scope and limitations.

## Close temporary evidence safely

Retain only records legitimately needed for support, security, billing, or household administration. Delete temporary screenshots and exports according to current privacy and support guidance. Never keep credentials in the scorecard.

## Original evidence: post-recovery integrity scorecard

| Area | Baseline | Recovered state | Classification | Owner |
| --- | --- | --- | --- | --- |
| Source authorization |  |  |  |  |
| Counts and categories |  |  |  |  |
| Item and version sample |  |  |  |  |
| Series and episodes |  |  |  |  |
| Metadata and artwork |  |  |  |  |
| Progress and favorites |  |  |  |  |
| Second device |  |  |  |  |
| Security and records |  |  |  |  |

## Common mistakes and limitations

- Stopping after one successful operation.
- Comparing a different profile, filter, or grouping state.
- Treating the old count as permanently correct.
- Checking catalog cards but ignoring progress and favorites.
- Declaring complete integrity from a tiny sample.
- Leaving secrets in temporary recovery records.

## Frequently asked questions

### Does one successful import close the incident?

No. Verify the scoped integrity scorecard and assign unexplained differences before closure.

### Must every count match the old baseline?

Not necessarily. Confirm legitimate source changes and comparable viewing context before interpreting a delta.

### How large should the sample be?

Use the smallest set covering the original symptom, an unaffected control, identity or version risk, series structure, and household state.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
