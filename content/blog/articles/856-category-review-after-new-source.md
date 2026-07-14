---
content_id: "NVB-856"
title: "Review Categories Immediately After Adding a Source"
seo_title: "Review Categories After Adding a Source"
meta_description: "Review categories after adding a source by preserving filters and grouping, comparing sample counts, checking source identity, and recording observed changes."
slug: "category-review-after-new-source"
canonical_url: "https://norva.tv/blog/category-review-after-new-source/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "post-connection-audit"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I review categories after adding a new source?"
supporting_questions:
  - "Which filters, grouping, counts, samples, and source labels should be compared?"
  - "How can unexpected category changes be documented without a full catalog export?"
audience:
  - "Norva users after a source addition"
  - "Households comparing catalog structure"
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
excerpt: "A category review freezes profile, filters, grouping, availability, and source state, then compares counts and small samples to the pre-connection baseline."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/verify-sample-after-source-connection/"
  - "/blog/baseline-before-second-source/"
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
  type: "post-source category delta register"
  summary: "A register captures timestamp, device, app version, profile, source labels, enabled state, availability and content filters, grouping, category names and counts, sample items, empty or new categories, duplicates, rollback, and resolution."
  methodology: "The reviewer reuses the privacy-safe baseline, changes no unrelated setting, records aggregates and masked samples, distinguishes observation from product rules, and escalates unexplained deltas with redacted evidence."
  asset_urls: []
---

# Review Categories Immediately After Adding a Source

> **In short:** Reuse the pre-connection baseline and keep the same profile, device, application version, source availability, filters, sort, and grouping. Record category names, displayed counts, a few privacy-safe samples, empty categories, new categories, missing categories, and duplicate behavior. Confirm which source each sample belongs to where the interface shows it. Document added, removed, changed, unchanged, or unknown results without exporting the full catalog or assuming one observation defines Norva's universal rules.

Categories are affected by source content, metadata, filters, grouping, availability, profile, and application state. An immediate review preserves the cleanest comparison window.

## Anchor the baseline

Open the [catalog-baseline guide](/blog/baseline-before-second-source/) and confirm the recorded timestamp, device, profile, versions, filters, grouping, category totals, and sample codes. If the environment already changed, note the difference instead of pretending the baseline still matches.

Do not rebuild the baseline after seeing the new result.

## Freeze visibility controls

Record source enabled state, availability selection, category filter, year, rating, audio, subtitle, sort, and version grouping where present. A hidden source or filter can make a healthy category appear absent.

Do not toggle several filters while counting.

## Compare category names and counts

Mark categories as added, removed, renamed, merged, split, unchanged, or unknown. Record approximate or displayed counts and the time observed. Counts can change as source data changes, so this is evidence for one moment rather than a permanent promise.

Avoid screenshots containing a complete private catalog.

## Inspect a small sample

The [small-sample verification guide](/blog/verify-sample-after-source-connection/) checks a few items across expected categories. Confirm source label, metadata completeness, duplicates or grouped versions, playback, and language tracks.

Use neutral sample codes when titles reveal sensitive interests.

## Investigate empty and missing categories

Check filters, source availability, item eligibility, metadata, permissions, and whether the source itself returns expected content. An empty category can reflect legitimate source state or a display issue.

Do not start another import, source addition, or credential reset merely to populate it.

## Review duplicate behavior

Select one known same-title or alternate-version example and record whether it remains separate or grouped. Do not infer grouping identifiers or priority rules that are not visible or documented.

If a group changes, preserve ordinary UI evidence for later comparison.

## Protect profile state

Confirm the expected profile and note a minimal progress or favorites sample. A profile mismatch can look like lost catalog context. The [progress-baseline guide](/blog/progress-baseline-after-source-change/) expands the item-identity check.

## Decide whether to keep or roll back

Before deciding, compare category meaning rather than labels alone. Two labels can look similar while exposing different samples, and one label can remain unchanged while its visible contents shift. For each important category, compare the displayed name with two or three representative items. Note whether each item comes from the new source, an existing source, or an unclear origin, and whether grouping changes the number of cards. This compact check separates naming changes from membership changes without copying the catalog. If the interface lacks enough context, mark the result unknown and preserve it for support.

If categories match the intended authorized source change, keep the configuration and record closure. If unexplained categories disappear or the new source replaces rather than adds expected state, remove only the new configuration and verify the prior baseline returns.

Send Norva support timestamps, versions, settings, aggregate counts, and masked samples, never source credentials.

## Original evidence: post-source category delta register

| Area | Before | After | Classification |
| --- | --- | --- | --- |
| Device, version, profile |  |  | Same or changed |
| Sources enabled |  |  |  |
| Filters and grouping |  |  |  |
| Category names |  |  | Added, removed, renamed |
| Category counts |  |  | Approximate delta |
| Sample items |  |  | Source and metadata |
| Empty categories |  |  | Observed or explained |
| Duplicate example |  |  | Separate or grouped |
| Rollback | Baseline | Result |  |

## Common mistakes and limitations

- Comparing different profiles or filters.
- Rebuilding the baseline after the change.
- Exporting a complete catalog unnecessarily.
- Treating one empty category as import failure.
- Resetting credentials during a display review.
- Inferring undocumented grouping rules.
- Changing another source before closing the audit.

## Frequently asked questions

### Why review categories immediately?

The shorter the gap, the fewer unrelated source, filter, profile, or application changes complicate attribution.

### Must category counts match forever?

No. They are a dated observation and can change with source state, metadata, eligibility, filters, and updates.

### What should I send support?

Send versions, profile and filter context, aggregate deltas, timestamps, and masked samples, never full catalogs or credentials.

## Your next step

[Open Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
