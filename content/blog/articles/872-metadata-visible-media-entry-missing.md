---
content_id: "NVB-872"
title: "Metadata Is Visible but the Media Entry Is Missing: What It Suggests"
seo_title: "Metadata Visible but Media Entry Missing"
meta_description: "Diagnose metadata without a usable entry by separating source availability, item identity, filters, grouping, profile, device, sync timing, and display context."
slug: "metadata-visible-media-entry-missing"
canonical_url: "https://norva.tv/blog/metadata-visible-media-entry-missing/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "metadata-entry-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose metadata without a usable catalog entry?"
supporting_questions:
  - "How can source availability, item identity, filters, grouping, profile, device, timing, and display be separated?"
  - "Which visible metadata fields create a useful support sample?"
audience:
  - "Norva users seeing metadata without a usable entry"
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
excerpt: "Visible metadata without a usable entry is a partial observation that requires separate checks of current source availability, identity, view controls, device context, and timeline."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/expected-items-missing-after-sync/"
  - "/blog/artwork-missing-after-import/"
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
  type: "metadata and entry state card"
  summary: "A state card records where metadata appears, which fields are visible, whether a card or detail route exists, current source availability, item and version cues, filters, grouping, profile, device, application version, and timeline."
  methodology: "The user documents the partial state, confirms the sample at the authorized source, searches and browses with stable controls, compares another device, and avoids assumptions about internal metadata retention."
  asset_urls: []
---

# Metadata Is Visible but the Media Entry Is Missing: What It Suggests

> **In short:** Record exactly where the metadata appears and which fields remain visible, then confirm whether a catalog card, detail page, or usable media entry exists. Check current availability at the authorized source, visible item and version identity, account, profile, source selection, filters, grouping, device, application version, and timeline. Compare another supported device and avoid assuming Norva retains, deletes, or matches metadata through any undocumented process.

Partial visibility is evidence, not a root cause. A title in search, an artwork tile without controls, a favorite reference, and a detail page without a current source entry represent different states.

## Define where metadata appears

Record the exact screen and route: search suggestion, category, favorite, progress row, recommendation, detail page, or another view. List visible fields such as title, year, description, artwork, source label, season, episode, duration, or version. Note which expected control or entry is absent.

## Confirm current source availability

Through the provider's official authorized route, verify whether the same sample is currently available to the household. Record time, media type, source version, and category. If the source no longer exposes it, preserve that observation without claiming how Norva should retain metadata.

The [missing-item evidence checklist](/blog/expected-items-missing-after-sync/) provides a three-sample method.

## Compare visible item identity

Use title, year, media type, season, episode, duration, source label, language or version cues, and artwork. A metadata fragment may refer to another edition or episode with a similar name. Do not inspect hidden databases or infer matching identifiers.

## Freeze view controls

Record the Norva account, profile, enabled sources, availability, category, year, rating, audio, subtitles, search query, sort, and grouping. Search and browse with one controlled change at a time. A card hidden by a filter can coexist with metadata visible in another context.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) separates view state from item identity.

## Separate artwork from entry state

Artwork and text can behave differently. Record whether the image loads, whether text fields load, and whether any usable entry or detail route exists. The [artwork diagnostic](/blog/artwork-missing-after-import/) applies when the entry exists but its image is missing.

## Build the timeline

Record the last known usable entry, source update, import or sync request and visible state, first partial metadata observation, and current result. Include timezone and device. Use official timing guidance only when Norva publishes it; otherwise report elapsed observations.

## Compare another supported device

Use the same trusted account, profile, source selection, filters, grouping, and sample close in time. Record both application versions. If the usable entry exists on one device, classify a cross-screen difference rather than asserting a server or local cause.

## Protect favorites and progress

If the metadata fragment appears through a favorite or progress row, do not remove it as a first test. Record its visible identity and state. Deleting the reference can eliminate useful evidence and may affect household organization.

## Avoid unsupported cleanup

Do not repeat imports, remove the source, clear application data, reinstall, edit source metadata, or bulk-delete references before preserving the baseline. If support recommends a step, label its time and outcome as a separate comparison.

## Classify the observation

Use source no longer available, found under another visible identity, hidden by view controls, metadata-only reference, one-view difference, one-device difference, artwork-only issue, resolved by documented step, or unknown. Do not claim a partial database record or internal retention rule without verified product evidence.

## Original evidence: metadata and entry state card

| Field | Observation |
| --- | --- |
| Screen or route |  |
| Visible metadata fields |  |
| Missing card, route, or control |  |
| Source current state |  |
| Item and version cues |  |
| Account, profile, filters, grouping |  |
| Device, version, timestamp |  |
| Other-device result |  |

## Common mistakes and limitations

- Calling partial metadata proof of a complete catalog entry.
- Ignoring version, episode, profile, or filter differences.
- Assuming undocumented retention or matching behavior.
- Deleting a favorite or progress reference before recording it.
- Editing source metadata before preserving the baseline.
- Sharing complete household history with support.

## Frequently asked questions

### Does visible metadata prove the media is available?

No. Confirm current source availability, usable entry state, view controls, and item identity as separate observations.

### Should I remove the favorite or progress row?

Not as a first diagnostic action. Preserve its identity and state, then follow current Norva support guidance.

### What if another device shows the full entry?

Record both contexts, versions, and timestamps. That establishes a cross-device difference but not its internal cause.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
