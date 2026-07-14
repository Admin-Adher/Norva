---
content_id: "NVB-882"
title: "Uncategorized Items After Import? A Classification Check"
seo_title: "Uncategorized Items After Import"
meta_description: "Troubleshoot uncategorized items after import by comparing source categories, item identity, media type, filters, profile, device, timing, and samples."
slug: "uncategorized-items-after-import"
canonical_url: "https://norva.tv/blog/uncategorized-items-after-import/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "category-classification-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot uncategorized items after import?"
supporting_questions:
  - "Which source categories, item identities, media types, filters, profiles, devices, and timestamps should be compared?"
  - "How can classification gaps be sampled without exporting the catalog?"
audience:
  - "Norva users seeing uncategorized catalog entries"
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
excerpt: "An uncategorized-item check verifies source category data and visible item identity, then freezes media type, profile, filters, device, and import timing before classification."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/expected-items-missing-after-sync/"
  - "/blog/incorrect-genre-tag/"
  - "/blog/empty-category-remains-visible/"
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
  type: "uncategorized item classification table"
  summary: "A table records source category presence, Norva category placement, item and version cues, media type, relevant metadata, profile, filters, grouping, device, application version, import timeline, and up to three samples."
  methodology: "The user confirms category data at the authorized source, freezes view context, compares affected and control items, changes one visible filter at a time, and avoids bulk metadata edits before support review."
  asset_urls: []
---

# Uncategorized Items After Import? A Classification Check

> **In short:** Select a few uncategorized entries and verify their current category data through the authorized source. Record visible item and version identity, media type, source label, year, genre, category, account, profile, filters, grouping, device, application version, and import timeline. Compare a normally categorized control item, change one visible filter at a time, and avoid bulk source edits or assumptions about Norva's classification rules.

“Uncategorized” may be an explicit category label, an item outside expected categories, or a search-only entry. Define the screen state before investigating its cause.

## Define the uncategorized state

Record where the item appears and the exact label or absence of a label. Note whether its card exists in search, all items, a media-type section, or only a detail view. Do not treat these views as interchangeable.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) provides the broader layer model.

## Choose representative samples

Select up to three affected items and one normally categorized control from the same source and media type. Assign neutral sample codes. Record title, year, media type, season or episode when relevant, duration, source, version, and visible category or genre fields.

Keep the control visible throughout the investigation. If it also becomes uncategorized after a filter, profile, or device change, the comparison now describes a broader context shift rather than an isolated item. Record that transition and restore the original context before continuing.

## Verify source category data

Through the provider's official authorized route, record whether each sample currently has a category, collection, genre, folder, or other visible classification field. Use the provider's own terminology. Do not assume different source fields map to one Norva category.

## Confirm item identity

Compare source, year, media type, duration, edition, season, episode, and language cues. A control item with the same title but another version may not be a valid classification comparison.

If only certain items are missing entirely, use the [missing-item checklist](/blog/expected-items-missing-after-sync/).

## Freeze view controls

Record account, profile, enabled sources, availability, media type, year, rating, audio, subtitles, search, sorting, and grouping. Remove one restriction at a time and return to baseline. A filtered category view can make an item appear classification-free even when another view places it.

## Compare metadata completeness

Record title, year, genre, description, artwork, runtime, and language cues independently. Missing or unusual metadata can be relevant evidence, but it does not prove why category placement differs. The [genre-tag guide](/blog/incorrect-genre-tag/) handles a specific genre mismatch.

## Preserve the import timeline

Record source confirmation, import request, visible stages, completion, first uncategorized observation, and later changes. Do not repeat imports to force classification. If current Norva support publishes timing guidance, cite it; otherwise report timestamps only.

## Compare another supported device

Use the same account, profile, source selection, filters, grouping, and samples close in time. Record both application versions. A category shown on one device only is a cross-screen difference, not proof of a particular local cause.

## Avoid bulk reclassification

Do not edit categories, genres, folders, filenames, or source metadata across many entries before saving the baseline. A broad edit can introduce new inconsistencies and remove the original comparison. Follow the source owner's authority and current support guidance.

## Classify the result

Use source category absent, source category present, different media type, item identity mismatch, hidden by view context, device-specific placement, changed after import, explicit uncategorized label, or unknown. Do not infer an undocumented fallback or mapping rule.

## Original evidence: uncategorized item table

| Field | Sample A | Sample B | Control |
| --- | --- | --- | --- |
| Source category data |  |  |  |
| Norva placement |  |  |  |
| Item and version cues |  |  |  |
| Media type and genre |  |  |  |
| Filters and grouping |  |  |  |
| Device and app version |  |  |  |
| Import timestamp |  |  |  |

## Common mistakes and limitations

- Assuming every source classification maps to a Norva category.
- Comparing different media types or versions.
- Ignoring profile, filters, or grouping.
- Editing many source records before preserving evidence.
- Repeating imports without a timeline.
- Exporting the household catalog for diagnosis.

## Frequently asked questions

### Does a source genre guarantee a Norva category?

Do not infer a guaranteed mapping. Record source and Norva fields independently and use current official documentation.

### Should I edit every uncategorized item?

No. Preserve a sample, confirm ownership and source behavior, and ask support before broad changes.

### What makes a good control item?

Choose a normally categorized item from the same source, media type, profile, and view context with comparable visible metadata.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
