---
content_id: "NVB-899"
title: "Metadata Corrections Overwritten After Refresh? Trace Ownership"
seo_title: "Metadata Corrections Overwritten? Trace Ownership"
meta_description: "Diagnose overwritten corrections by recording field ownership, original and edited values, source confirmation, refresh sequence, device, version, and timing."
slug: "metadata-corrections-overwritten-after-refresh"
canonical_url: "https://norva.tv/blog/metadata-corrections-overwritten-after-refresh/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "metadata-correction-ownership-guide"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose overwritten metadata corrections?"
supporting_questions:
  - "Which field owner, original value, edit, source confirmation, refresh, profile, device, version, and timing evidence should be recorded?"
  - "How can correction persistence remain unpromised until verified?"
audience:
  - "Norva users maintaining authorized source metadata"
  - "Household metadata administrators"
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
excerpt: "A correction-ownership record connects each field's authoritative source with its original value, edit, confirmation, refresh sequence, visible result, profile, device, and time."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/stale-synopsis-after-refresh/"
  - "/blog/import-fails-after-credential-rotation/"
  - "/blog/metadata-support-evidence-pack/"
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
  type: "metadata correction ownership ledger"
  summary: "A ledger records field name, authoritative owner, original value, edited value, editor authorization, edit and source confirmation times, import or refresh sequence, Norva value by view, device and application version, and outcome."
  methodology: "The user records one field change, verifies it in the authoritative source, freezes view context, observes one refresh sequence, avoids repeated edits, and separates persistence evidence from assumptions about overwrite priority."
  asset_urls: []
---

# Metadata Corrections Overwritten After Refresh? Trace Ownership

> **In short:** Identify who owns the field and where the authoritative edit was made. Record the original value, edited value, editor authorization, source confirmation time, import or refresh request, every visible state, Norva value by view, account, profile, device, application version, and timestamp. Change one field once, avoid repeated edits, and do not promise persistence or infer an overwrite priority until current provider and Norva documentation verify it.

A correction that appears and later changes again creates an ownership and timeline question. The visible sequence does not reveal whether the source, another administrator, an import, or another field supplied the later value.

## Name the exact field

Record title, localized title, year, genre, synopsis, rating, runtime, poster, season, episode, audio label, subtitle label, or another explicit field. Do not combine several corrected values into one test.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) provides a field-by-field matrix.

## Identify the authoritative owner

Record the source provider or household system that owns the field, the authorized editor, and the provider's supported correction route. A person who can view a source is not necessarily authorized to edit its metadata.

## Preserve original and edited values

Save concise before and after evidence, exact field labels, item and version identity, language, and timestamp. For protected descriptions, use short distinguishing excerpts. For images, record state without copying private image addresses.

## Confirm the edit at the source

Through the provider's official authorized route, verify the edited value became visible and record confirmation time. Keep edit submission and source confirmation separate. Do not infer provider processing behavior.

## Freeze Norva view context

Record account, profile, enabled sources, filters, grouping, device, operating system, application version, network, and view. Confirm the same item and source version remains selected.

## Observe one refresh sequence

Record import or refresh request, acknowledgment, stages, completion or last change, first Norva value, later changed value, and every user action. Use current official timing guidance only when published. Do not issue repeated refreshes while trying to catch a change.

The [stale-synopsis guide](/blog/stale-synopsis-after-refresh/) provides a concise text comparison.

## Check other authorized editors

Ask whether another source administrator, automated provider process explicitly documented by that provider, or household workflow changed the field after confirmation. Record confirmed actions only. Do not accuse another person or invent an automation.

## Compare another supported device

Use the same account, profile, source version, filters, grouping, and close time. Record both application versions. Different values on two devices establish a cross-screen observation, not which system owns the later value.

## Protect credentials and access

Metadata investigation never requires credentials in the ledger. If credential rotation or access changes occurred during the sequence, record only masked status and use the [post-rotation guide](/blog/import-fails-after-credential-rotation/).

## Avoid edit loops

Repeatedly writing the preferred value can obscure which source and event supplied each result. Stop after one documented authorized edit. Do not rename files, change several fields, remove the source, or clear application data before support reviews the ledger.

## Classify the sequence

Use edit not confirmed at source, source confirmed then changed, Norva never showed edit, Norva showed then changed, view-specific difference, device-specific difference, another authorized edit confirmed, item or version changed, or unknown. Do not state a priority or persistence rule without verified documentation.

## Prepare support evidence

Use the [metadata evidence pack](/blog/metadata-support-evidence-pack/) with field ownership, before and after values, source confirmation, refresh sequence, views, devices, versions, actions, and redactions. Exclude passwords and full private catalog data.

## Original evidence: correction ownership ledger

| Event | System and owner | Field value | Time | Evidence |
| --- | --- | --- | --- | --- |
| Original |  |  |  |  |
| Edit submitted |  |  |  |  |
| Source confirmed |  |  |  |  |
| Norva first observed |  |  |  |  |
| Refresh |  |  |  |  |
| Later value |  |  |  |  |

## Common mistakes and limitations

- Editing several fields in one test.
- Confusing edit submission with source confirmation.
- Repeating refreshes and edits without a sequence.
- Assuming Norva or the source has a particular priority.
- Ignoring other authorized edits or item-version changes.
- Recording credentials in the ownership ledger.

## Frequently asked questions

### Will a source correction persist after every refresh?

Do not promise persistence without current provider and Norva documentation. Record the observed sequence for the exact field.

### Should I keep reapplying the correction?

No. One documented authorized edit provides clearer evidence than an edit loop.

### What if another administrator changed the field?

Record the confirmed authorized action and time. Keep it in the sequence without attributing undocumented behavior or intent.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
