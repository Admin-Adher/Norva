---
content_id: "NVB-865"
title: "Why Catalog Counts Can Change Between Imports"
seo_title: "Why Catalog Counts Change Between Imports"
meta_description: "Investigate changing catalog counts by comparing source state, filters, grouping, metadata, eligibility, timing, account, profile, device, and item samples."
slug: "catalog-count-changes-between-imports"
canonical_url: "https://norva.tv/blog/catalog-count-changes-between-imports/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "catalog-count-analysis"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Why can item counts change across catalog imports?"
supporting_questions:
  - "Which source, filter, grouping, metadata, eligibility, timing, profile, and device contexts should be compared?"
  - "How can membership changes be sampled without exporting the catalog?"
audience:
  - "Norva users comparing catalog counts"
  - "Household administrators monitoring source changes"
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
excerpt: "Catalog counts are snapshots whose meaning depends on source membership, viewing controls, grouping, eligibility, metadata, account and profile, device, and observation time."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/category-counts-differ-across-devices/"
  - "/blog/duplicates-after-repeat-import/"
cta:
  label: "Review Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "catalog count context comparison"
  summary: "A comparison records timestamp, source state, account and profile, device and application version, filters, categories, grouping, displayed total, and small added, removed, or changed item samples."
  methodology: "The user recreates the earlier viewing context, compares aggregate counts and minimal samples, labels expected source changes separately from unexplained differences, and avoids inferring undocumented counting logic."
  asset_urls: []
---

# Why Catalog Counts Can Change Between Imports

> **In short:** Treat every catalog count as a timestamped view, not a permanent inventory promise. Recreate the same authorized source state, account, profile, device, application version, filters, category, availability, sort, and grouping before comparing. Then inspect a few added, removed, or changed entries and visible metadata. Separate expected source updates from display-context differences, and do not infer Norva's internal counting, eligibility, or duplicate rules.

A count is useful only when its scope is clear. Two numbers can both be accurate for different sources, profiles, categories, grouping choices, devices, or moments.

## Recover the earlier baseline

Find the earlier timestamp, displayed total, source labels, account, profile, device, application version, filters, grouping, and category. If any field is missing, mark the comparison limited. Do not rebuild the baseline from memory after seeing the new number.

The [troubleshooting handbook](/blog/catalog-import-sync-troubleshooting-handbook/) provides a reusable context matrix.

## Verify source membership changed or stayed stable

Ask the authorized source owner whether content, access scope, account role, provider endpoint, or source configuration changed between observations. Use the provider's official interface for aggregate evidence. Do not assume a changed source catalog is an error, and do not copy its complete contents.

## Freeze view controls

Match source availability, category, year, rating, audio, subtitles, search query, sort, and grouped-version setting where visible. Record every difference. A filter can lower a count, while grouping can change the number of visible cards without proving media was removed.

The [category-count cross-device guide](/blog/category-counts-differ-across-devices/) helps when contexts differ by screen.

## Separate cards, versions, and source entries

One visible card may represent a different comparison unit from one source version or one episode. Use only terminology the interface or current documentation supports. Do not infer a hidden deduplication key or claim that two same-title cards must merge.

If repeat actions produced apparent duplicates, use the [duplicate comparison](/blog/duplicates-after-repeat-import/) before deleting anything.

## Record metadata and eligibility signals

Compare media type, year, category, source label, version, duration, season, episode, and availability where shown. Metadata can change how an entry appears or whether it is found by a visible filter. Do not invent catalog eligibility rules; cite current Norva support if it documents one.

## Account for observation timing

Record when the source changed, when each operation occurred, and when each count was observed. If official guidance publishes a timing window, use the current statement. Otherwise, describe the timeline without promising that all screens must converge after an arbitrary interval.

## Compare account, profile, and device

Ensure the same Norva account and profile are active. On a second trusted supported device, match filters, grouping, source selection, and observation time as closely as practical. Different counts on one screen are evidence of a context difference, not automatic proof of stale local data.

## Sample membership changes

Choose a few entries from the apparent difference: an item present before but absent now, a new item, and a version or episode affected by grouping. Assign privacy-safe sample codes and record visible identity cues. This tests what the count change represents without exporting the household catalog.

## Classify the delta carefully

Use expected source change, filter difference, grouping difference, account or profile difference, device-specific display, metadata change, item-identity change, or unknown. Keep hypotheses separate. A numerical delta alone cannot establish which items changed or why.

## Original evidence: catalog count context comparison

| Context | Earlier observation | Current observation | Same? |
| --- | --- | --- | --- |
| Time and source state |  |  |  |
| Account and profile |  |  |  |
| Device and version |  |  |  |
| Filters and category |  |  |  |
| Grouping and sort |  |  |  |
| Displayed total |  |  |  |
| Added sample |  |  |  |
| Removed sample |  |  |  |

## Common mistakes and limitations

- Comparing counts without their filters and grouping.
- Treating a card count as a version or episode count.
- Assuming the source stayed unchanged.
- Declaring a device cache problem from one screen.
- Inferring undocumented eligibility or matching rules.
- Exporting a private catalog to explain a small delta.

## Frequently asked questions

### Should two imports always produce the same count?

Only if the source and every relevant viewing context remain comparable. Even then, record the observation rather than promising permanence.

### Does a lower count prove items were deleted?

No. Filters, grouping, account scope, metadata, device context, and source membership must be compared before interpreting the number.

### What should I share with support?

Share both timestamped contexts, aggregate totals, visible controls, device versions, masked source labels, and a few redacted sample identities.

## Your next step

[Review Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
