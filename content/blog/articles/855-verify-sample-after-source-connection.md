---
content_id: "NVB-855"
title: "Verify a Small Catalog Sample After Connecting a Source"
seo_title: "Verify a Catalog Sample After Source Setup"
meta_description: "Verify a new source with a small sample of categories, metadata, duplicates, playback, seeking, audio, subtitles, progress, behavior, and rollback evidence."
slug: "verify-sample-after-source-connection"
canonical_url: "https://norva.tv/blog/verify-sample-after-source-connection/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "post-connection-verification-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I verify a new source connection with a small catalog sample?"
supporting_questions:
  - "Which catalog, metadata, playback, language, progress, and device checks matter?"
  - "How can verification stay minimal and privacy-safe?"
audience:
  - "Norva users after connecting a source"
  - "Households validating a controlled source change"
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
excerpt: "A small repeatable sample can verify source identity, catalog structure, metadata, playback, language tracks, progress, and supported-device behavior without exporting the full catalog."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/connect-one-source-at-a-time/"
  - "/blog/baseline-before-second-source/"
  - "/blog/category-review-after-new-source/"
  - "/blog/progress-baseline-after-source-change/"
cta:
  label: "Open Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "small catalog verification sample card"
  summary: "A card records source label, timestamp, device and app version, profile, filters, sample selection rule, category, metadata, grouping, start, seek, audio, subtitles, progress, second supported device, unexpected delta, and decision."
  methodology: "The user selects a small non-sensitive authorized sample before testing, freezes unrelated settings, records observations without full catalog export, and labels one-item success as a sample rather than universal proof."
  asset_urls: []
---

# Verify a Small Catalog Sample After Connecting a Source

> **In short:** Choose an authorized sample before testing: a few items across categories, formats, languages, or versions without exposing the whole catalog. Record source label, profile, filters, device, application version, and timestamp. Check metadata, grouping, playback start, seeking, audio, subtitles, and progress; then repeat one item on a supported device if relevant. Compare the baseline, document unexpected changes, and keep or roll back the source without treating sample success as universal proof.

Sampling gives a fast, repeatable signal while limiting personal-data collection and unnecessary load on the source.

## Start from the prior baseline

Use the [catalog-baseline guide](/blog/baseline-before-second-source/) to preserve source count, filters, grouping, categories, approximate totals, profile state, and one prior playback example. Do not change those settings during verification.

A baseline makes the sample comparable rather than anecdotal.

## Define the selection rule

Choose a few authorized items that cover meaningful differences: one common item, one with audio or subtitle choices, one alternate version, and one recently added item where relevant. Avoid sensitive titles in shared evidence.

Record sample codes instead of full names when privacy warrants it.

## Verify source and category placement

Confirm the privacy-safe source label is present and the sample appears in expected categories under current filters. The [category-review guide](/blog/category-review-after-new-source/) expands this into a complete post-addition audit.

Do not assume a missing sample means failed import until filters, availability, grouping, and source response are checked.

## Verify metadata and grouping

Inspect title, year, artwork presence, description, version, audio and subtitle labels, and source association where shown. Record observed completeness, not a claim that metadata is objectively correct.

If grouped versions split or merge, preserve identifiers available through ordinary UI or support evidence without extracting private source data.

## Verify playback behavior

Start each sample, allow enough playback to confirm response, seek once where supported, and stop. Do not perform long automated testing or repeated rapid requests. Record exact errors and timestamps.

Offline use is separate and depends on supported device, compatible source, eligible media, storage, and rights.

## Verify language tracks

For a sample known to have choices, check whether expected audio and subtitle labels appear and whether selection changes playback. Do not infer that every catalog item has the same tracks.

Record selected labels, not spoken or displayed content.

## Verify progress identity

Start from a known progress state or create a small test position, then check whether it remains associated with the expected item and profile. The [progress-baseline guide](/blog/progress-baseline-after-source-change/) protects against confusing alternate versions or changed source identities.

## Compare a supported device

If cross-device continuity matters, repeat one sample on another currently supported trusted device. Confirm the same profile, filters, source availability, app version, and network context. Do not assume synchronization timing; record timestamps and official guidance.

## Decide and clean up

The [one-source-at-a-time guide](/blog/connect-one-source-at-a-time/) defines success and rollback. Keep the source only when authorization, catalog delta, and sample behavior are acceptable. Delete temporary screenshots and masked samples after the support purpose ends.

## Preserve repeatability

Write the sample selection rule, not just the results. Future reviews should be able to choose comparable items without depending on one title that may disappear. Record why an item was chosen, such as known subtitles or alternate version, and replace it deliberately when source availability changes. Keep the sample small enough that a household can rerun it after updates.

## Original evidence: small catalog verification sample card

| Check | Sample A | Sample B | Sample C |
| --- | --- | --- | --- |
| Category and source label |  |  |  |
| Metadata completeness |  |  |  |
| Version or grouping |  |  |  |
| Playback start and seek |  |  |  |
| Audio and subtitles |  |  |  |
| Progress identity |  |  |  |
| Second supported device |  |  |  |
| Result |  |  |  |

## Common mistakes and limitations

- Exporting the whole catalog for a small check.
- Selecting only one easy item.
- Changing filters during comparison.
- Treating missing items as import failure immediately.
- Claiming one successful sample proves all playback.
- Ignoring profile and version identity.
- Keeping sensitive screenshots indefinitely.

## Frequently asked questions

### How large should the sample be?

Use the smallest set that covers the important categories, metadata, versions, language tracks, playback, and profile behavior for your source.

### Does one successful item prove the source works?

No. It is one data point; a diverse small sample gives better confidence without claiming complete coverage.

### Should I include private titles in support evidence?

Use masked sample codes and only the minimum metadata needed to explain the issue through official support.

## Your next step

[Open Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
