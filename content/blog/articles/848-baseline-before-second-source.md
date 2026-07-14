---
content_id: "NVB-848"
title: "Record a Catalog Baseline Before Adding a Second Source"
seo_title: "Record a Catalog Baseline Before a Second Source"
meta_description: "Record source count, versions, filters, categories, totals, metadata, duplicates, profile state, and a small playback sample before adding a second source."
slug: "baseline-before-second-source"
canonical_url: "https://norva.tv/blog/baseline-before-second-source/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "catalog-baseline-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What catalog baseline should I record before adding a second source?"
supporting_questions:
  - "Which settings, counts, metadata, profile state, and playback observations are useful?"
  - "How can the baseline remain minimal and privacy-safe?"
audience:
  - "Norva users preparing a second source"
  - "Households troubleshooting catalog changes"
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
excerpt: "A privacy-safe baseline captures enough catalog, setting, profile, and playback evidence to attribute a later change without exporting the household's full library or history."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/connect-one-source-at-a-time/"
  - "/blog/privacy-safe-source-display-name/"
  - "/blog/choose-screen-for-source-setup/"
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
  type: "privacy-safe catalog baseline card"
  summary: "A card records timestamp, device, app version, source label, filters, grouping, availability settings, category and item counts, sample metadata, duplicates, favorites and progress state, playback sample, and redaction level."
  methodology: "The user collects aggregate counts and a small authorized sample, avoids full catalog or history export, masks titles when sensitive, freezes unrelated settings, and repeats the same checks after one source change."
  asset_urls: []
---

# Record a Catalog Baseline Before Adding a Second Source

> **In short:** Before adding another source, record the timestamp, device, Norva version, current privacy-safe source label, active filters, grouping and availability settings, category totals, approximate item counts, metadata completeness, known duplicate examples, favorite and progress state, and a small authorized playback sample. Use aggregates and masked examples rather than exporting a full catalog or household history. Freeze unrelated settings, add one source, then repeat the same observations to identify the actual delta.

A baseline turns "the catalog changed" into a set of repeatable observations. It is not a permanent inventory of everything a household watches.

## Define the comparison question

Decide what the second source is expected to add: another authorized catalog, alternate versions, missing metadata, or household coverage. Do not assume Norva's current grouping or source-priority behavior beyond official documentation and observed settings.

The [one-source-at-a-time guide](/blog/connect-one-source-at-a-time/) makes the new source the only planned variable.

## Record the technical context

Capture device class, operating-system version, Norva version, network context, profile, and timestamp. A later application update or different profile can change results independently of the source.

Avoid storing device identifiers or network addresses.

## Record source and filter state

Use the [privacy-safe source naming guide](/blog/privacy-safe-source-display-name/) and record the visible label, source enabled state, availability filter, categories, sort, grouping, language, year, rating, audio, and subtitle filters that affect the view.

Do not record the source address or credential.

## Use aggregate catalog measures

Record category names and approximate or displayed counts when available. Choose a few non-sensitive sample items to inspect title, year, artwork, description, version, audio, and subtitle metadata.

Avoid exporting the full catalog. If titles themselves are sensitive, assign neutral sample codes and keep the mapping private or omit it.

## Note duplicate and grouping behavior

Choose one known same-title or alternate-version example if authorized and record whether items are separate or grouped under current settings. Do not infer universal deduplication rules from one example.

After the second source, repeat the same sample and describe only the observed change.

## Preserve profile state

Record the count or presence of a few favorites, recent items, and progress entries without copying complete history. The goal is to notice accidental loss or profile mismatch, not to create another usage-data archive.

Norva's privacy notice treats history, progress, favorites, and preferences as account-related usage data.

## Test one authorized playback sample

Record whether a small sample starts, seeks, presents expected audio or subtitles, and preserves progress. Use eligible authorized media only. Do not claim that one sample proves the full source works.

Offline behavior is separate and depends on supported device, compatible source, eligible media, storage, and rights.

## Repeat without changing the method

After adding the source, use the same device, profile, settings, sample codes, and sequence where possible. The [setup-screen guide](/blog/choose-screen-for-source-setup/) helps pick a reliable device for both entry and verification.

Record differences as added, removed, changed, unchanged, or unknown.

## Limit baseline retention

Keep the baseline only as long as it supports setup, troubleshooting, or a documented maintenance purpose. Remove redundant screenshots and full-title lists after the comparison closes. Preserve aggregate findings and the final decision when useful. If support needs a sample, create a fresh redacted copy rather than forwarding the private working record unchanged.

## Original evidence: privacy-safe catalog baseline card

| Area | Before | After | Delta |
| --- | --- | --- | --- |
| Device, app, profile, time |  |  |  |
| Source labels and enabled state |  |  |  |
| Filters and grouping |  |  |  |
| Category and item totals |  |  |  |
| Sample metadata |  |  |  |
| Duplicate example |  |  |  |
| Favorites and progress sample |  |  |  |
| Playback sample |  |  |  |

## Common mistakes and limitations

- Exporting a full private catalog unnecessarily.
- Omitting filters and grouping state.
- Updating the application during comparison.
- Using another profile after the change.
- Recording source addresses or credentials.
- Treating one playback sample as complete proof.
- Interpreting an observed delta as a universal product rule.

## Frequently asked questions

### Must I record every title?

No. Aggregate counts and a small privacy-safe sample usually provide better comparison with less personal-data exposure.

### Should favorites and progress be included?

Use only a minimal sample to detect profile or state loss; do not duplicate the household's full usage history.

### What if filters changed automatically?

Record the observed setting change, restore the intended baseline if safe, and ask official support rather than assuming the source caused it.

## Your next step

[Open Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
