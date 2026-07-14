---
content_id: "NVB-870"
title: "Category Counts Differ Across Devices? Compare Context First"
seo_title: "Category Counts Differ Across Devices"
meta_description: "Diagnose category count differences across devices by matching account, profile, source, filters, grouping, versions, timestamps, category meaning, and samples."
slug: "category-counts-differ-across-devices"
canonical_url: "https://norva.tv/blog/category-counts-differ-across-devices/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "cross-device-category-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose cross-device category count differences?"
supporting_questions:
  - "Which account, profile, source, filter, grouping, version, time, and category contexts must match?"
  - "How can a view difference be distinguished from a membership difference?"
audience:
  - "Norva users comparing categories across devices"
  - "Households with multiple supported screens"
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
excerpt: "A category-count comparison aligns account, profile, sources, filters, grouping, versions, time, and category meaning before sampling which entries actually differ."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/catalog-count-changes-between-imports/"
  - "/blog/one-device-shows-old-catalog/"
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
  type: "cross-device category count matrix"
  summary: "A matrix compares account, profile, source selection, filters, grouping, device and application versions, observation time, category label, displayed count, and representative category members."
  methodology: "The user aligns contexts, records counts close together, samples category membership without exporting catalogs, changes one visible control at a time, and classifies view, membership, timing, or unknown differences."
  asset_urls: []
---

# Category Counts Differ Across Devices? Compare Context First

> **In short:** Align both devices before comparing numbers: use the same Norva account, profile, authorized sources, availability, category, year, rating, audio, subtitles, search query, sorting, and grouping. Record device, operating system, application version, network, and close timestamps. Then compare several representative category members, not just totals. Classify view-context, membership, timing, item-identity, device-specific, or unknown differences without assuming an undocumented counting rule.

Two category totals can differ because the screens count or display different contexts. The investigation should prove equivalence before treating the numbers as conflicting evidence.

## Define the exact category

Record the displayed category label, path, media type, source scope, and any parent selection. Similar labels do not guarantee identical membership. If a label is translated or shortened differently, use representative items to confirm that the intended category is being compared.

## Align account and profile

Verify the same Norva account and active profile on both devices. Record household role where relevant without exposing personal data. Do not assume profiles share identical preferences, history, or visible state.

## Align sources and view controls

Match enabled source labels, availability, year, rating, audio, subtitles, search query, sorting, and grouped-version state. Record every value on both screens. Change one mismatch at a time and return to the baseline before the next test.

The [catalog-count guide](/blog/catalog-count-changes-between-imports/) explains why totals need a complete scope.

## Record device and timing context

Capture device model, operating system version, Norva application version, network type, and observation time with timezone. Compare within a short documented interval. If a source or sync changed between observations, preserve that event in the timeline.

For a broader one-device difference, use the [older-catalog cross-screen check](/blog/one-device-shows-old-catalog/).

## Confirm what the number represents

Use only the interface wording and current official documentation. A number may appear next to a category, search result, grouped view, or media type. Do not call it a raw imported-item count or unique-title count unless Norva explicitly defines it that way.

## Sample category membership

Choose three privacy-safe examples: one present on both devices, one apparently present only on device A, and one apparently present only on device B. Record source label, title sample code, year, version, duration, and grouping cues. Search for the same identities outside the category before calling them absent.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) provides the item-identity layer.

## Separate view from membership

If aligning a filter makes the totals equal, classify a view-context difference. If totals remain different but the sampled members are identical, the number may require support interpretation. If sampled membership differs, preserve which entries and identity cues differ. Do not extrapolate three samples to the complete category.

## Use safe comparisons before resets

Follow current Norva support guidance for any documented refresh or navigation step. Avoid clearing application data, reinstalling, removing sources, repeating imports, or bulk-editing categories as initial tests. These actions can destroy the paired context.

## Escalate paired observations

Send both device contexts, close timestamps, visible category labels, aggregate counts, every filter and grouping setting, masked source labels, versions, network types, and redacted samples. Exclude full catalogs, credentials, private addresses, and unrelated history.

## Classify the result

Use category-label mismatch, account or profile mismatch, source-selection difference, filter or grouping difference, timing difference, membership difference, item-identity difference, device-specific display, or unknown. Keep possible causes separate from the observed classification.

## Original evidence: cross-device category count matrix

| Context | Device A | Device B | Same? |
| --- | --- | --- | --- |
| Account and profile |  |  |  |
| Category and media type |  |  |  |
| Sources and availability |  |  |  |
| Filters, sort, grouping |  |  |  |
| Device, OS, app version |  |  |  |
| Network and timestamp |  |  |  |
| Displayed count |  |  |  |
| Three member samples |  |  |  |

## Common mistakes and limitations

- Comparing similar labels without checking membership.
- Ignoring profile, source, language, or grouping settings.
- Assuming the displayed number has an undocumented definition.
- Comparing screens observed at different source states.
- Resetting a device before saving paired evidence.
- Exporting complete household categories for support.

## Frequently asked questions

### Must category counts match across every device?

Only comparable contexts produce a meaningful test. If aligned contexts still differ, record the evidence and ask support rather than promising equality.

### Can grouping change the displayed total?

It may change the visible context. Record the setting and observed result without inferring the underlying counting implementation.

### What if the totals differ but sampled items match?

Preserve both facts. A small matching sample cannot explain the total, so support may need the paired context and additional redacted examples.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
