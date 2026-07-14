---
content_id: "NVB-881"
title: "The Complete Category and Metadata Troubleshooting Handbook"
seo_title: "Category and Metadata Troubleshooting Handbook"
meta_description: "Troubleshoot catalog categories and metadata by separating source data, item identity, view controls, device context, timing, and presentation evidence."
slug: "category-metadata-troubleshooting-handbook"
canonical_url: "https://norva.tv/blog/category-metadata-troubleshooting-handbook/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-handbook"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot catalog categories and metadata?"
supporting_questions:
  - "How should source data, item identity, view context, devices, timing, and presentation be separated?"
  - "Which minimal evidence helps support without exposing a household catalog?"
audience:
  - "Norva users diagnosing category and metadata differences"
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
estimated_reading_minutes: 9
excerpt: "A disciplined category and metadata investigation separates source observations, visible item identity, view controls, device context, timing, and presentation before any correction."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/uncategorized-items-after-import/"
  - "/blog/duplicate-category-names/"
  - "/blog/localized-title-mismatch/"
  - "/blog/missing-poster-artwork/"
  - "/blog/metadata-support-evidence-pack/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.nist.gov/privacy-framework"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "category and metadata evidence matrix"
  summary: "A matrix records the symptom, source observation, item and version identity, category membership, visible metadata fields, account and profile, filters and grouping, device and application version, timeline, comparison, and action log."
  methodology: "The user freezes context, selects a minimal authorized sample, verifies source and Norva observations independently, changes one reversible view control at a time, and separates facts from hypotheses before escalation."
  asset_urls: []
---

# The Complete Category and Metadata Troubleshooting Handbook

> **In short:** Describe one visible category or metadata symptom, preserve its first timestamp, and freeze the account, profile, source selection, filters, grouping, device, and application version. For a small authorized sample, compare source data, item and version identity, category membership, and each displayed field independently. Change one reversible view control at a time, avoid source edits, and send support redacted observations rather than an invented explanation.

Categories and metadata help people find and recognize media, but a visible mismatch can originate in source data, item identity, view context, timing, or presentation. The interface alone does not reveal an internal rule, so evidence must remain layered.

## Name the smallest symptom

Choose one observable result: an item is uncategorized, two category labels look duplicated, an empty category remains, category order changes, a title or year differs, artwork is absent, a synopsis appears old, a rating is missing, or a badge disagrees with the visible track list. Avoid “metadata is broken,” which hides useful distinctions.

## Freeze the viewing context

Record the Norva account, active profile, enabled source labels, availability, category, year, rating, audio, subtitles, search query, sorting, grouping, device, operating system, application version, network, and timestamp. A different filter or profile can create a new view without changing source data.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) covers upstream operation states when the issue began during import.

## Separate six evidence layers

Keep these observations distinct:

1. What the authorized source currently exposes.
2. Which logical item or version is being compared.
3. Which category or metadata field appears in Norva.
4. Which view controls affect visibility or presentation.
5. Which device, version, and time produced the screen.
6. Which edits, imports, refreshes, or user actions occurred.

A correlation between layers is useful, but it is not a verified product rule.

## Build a minimal sample

Choose up to three entries: one affected item, one unaffected control from the same context, and one alternate source or version when relevant. Assign privacy-safe sample codes. Record visible title, year, media type, source, season, episode, duration, version, language cues, artwork, category, and the field under investigation.

Do not export the household catalog or complete viewing history.

## Verify the source observation

Through the provider's official authorized route, record the same field and item cues with a timestamp. Note whether the value is absent, different, or changed recently. Source data is one input observation; it does not by itself establish what Norva must display or how it maps fields.

## Confirm item and version identity

Same-title entries may represent different years, cuts, episodes, source versions, languages, or durations. Compare ordinary interface cues before treating values as contradictory. The [runtime comparison](/blog/runtime-differs-between-versions/) shows why identity matters.

## Compare fields independently

Record title, year, genre, synopsis, rating, poster, runtime, audio badge, subtitle badge, and track list as separate rows. One correct field does not prove every field has the same source or update state. Missing artwork is not missing media, and a badge is not the same observation as a playback track list.

Use the [poster checklist](/blog/missing-poster-artwork/) and [localized-title comparison](/blog/localized-title-mismatch/) for focused branches.

## Change one reversible view control

Remove one visible filter, switch between category and search, or check another supported trusted device while keeping every other context stable. Return to baseline before the next comparison. Do not clear application data, reinstall, remove the source, or edit source metadata as first steps.

## Preserve the timeline

Record the source value confirmation, import or refresh request, visible state, first mismatch, every correction attempt, and current observation. Use only timing guidance published by current Norva support. Otherwise report elapsed time without inventing an update promise.

## Treat corrections as owned changes

Before editing anything, identify whether the household controls the source field and whether the provider supports a correction. Record who made the change, where, when, and what value existed before. Do not promise that an edit will persist through future source updates or refreshes.

The [correction ownership guide](/blog/metadata-corrections-overwritten-after-refresh/) helps when an edit later changes again.

## Escalate a compact evidence pack

Send support one symptom, the stable context, source observation, visible item identity, affected field, timeline, up to three samples, controlled comparison, and action log. Remove credentials, private source addresses, complete catalogs, and unrelated profile data. The [metadata evidence pack](/blog/metadata-support-evidence-pack/) provides a reusable structure.

## Original evidence: category and metadata matrix

| Layer | Affected sample | Control sample | Observation time |
| --- | --- | --- | --- |
| Source field |  |  |  |
| Item and version identity |  |  |  |
| Category membership |  |  |  |
| Norva field or badge |  |  |  |
| Filters and grouping |  |  |  |
| Device and app version |  |  |  |
| Action history |  |  |  |

## Common mistakes and limitations

- Treating similar titles as identical versions.
- Comparing different profiles, filters, or devices.
- Editing the source before preserving its original value.
- Assuming one field reveals Norva's mapping logic.
- Repeating imports or refreshes without a timeline.
- Sending complete catalogs or credentials to support.

## Frequently asked questions

### Which value should be treated as authoritative?

Record each authoritative system for its own observation. Do not infer that one visible value automatically controls every Norva field.

### Should I correct source metadata immediately?

Preserve the baseline first and confirm authorization and ownership. An edit changes the input and may hide the original mismatch.

### How many samples should I document?

Use the smallest representative set, commonly one affected item, one control, and one alternate version when identity is uncertain.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [NIST Privacy Framework](https://www.nist.gov/privacy-framework)
