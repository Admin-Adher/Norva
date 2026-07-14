---
content_id: "NVB-869"
title: "One Device Shows an Older Catalog: A Cross-Screen Check"
seo_title: "One Device Shows an Older Catalog"
meta_description: "Troubleshoot stale catalog state on one device by matching account, profile, source, filters, grouping, versions, network, timestamps, counts, and item samples."
slug: "one-device-shows-old-catalog"
canonical_url: "https://norva.tv/blog/one-device-shows-old-catalog/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "cross-device-catalog-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot stale catalog state on one device?"
supporting_questions:
  - "Which account, profile, source, filter, grouping, version, network, and time contexts must match?"
  - "Which safe comparisons should happen before clearing device data?"
audience:
  - "Norva users seeing different catalogs across devices"
  - "Households using multiple supported screens"
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
excerpt: "A cross-screen check first proves the two devices share the same account, profile, source, filters, grouping, timing, and sample identity before changing local state."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/delayed-sync-after-source-update/"
  - "/blog/category-counts-differ-across-devices/"
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
  type: "cross-screen catalog context matrix"
  summary: "A matrix compares account, profile, source selection, filters, category, grouping, device, operating system, application version, network, observation time, totals, and three privacy-safe item samples."
  methodology: "The user aligns visible contexts, observes both devices close together, performs only documented non-destructive refresh behavior, avoids clearing data first, and escalates the paired evidence."
  asset_urls: []
---

# One Device Shows an Older Catalog: A Cross-Screen Check

> **In short:** Before calling one catalog old, verify both devices use the same Norva account, profile, authorized source selection, category, filters, search query, sorting, grouping, and close observation time. Record device, operating system, application version, network, displayed count, and a few item samples. Use only current documented refresh behavior, avoid clearing data or reinstalling first, and preserve paired screenshots or notes for support.

Cross-device differences are easy to misread because two screens can look similar while using different profiles, versions, filters, or timestamps. The goal is to make the comparison genuinely equivalent.

## Define why one screen looks older

Choose observable differences: a recently added item is absent, a removed item remains, metadata has not changed, artwork differs, category counts differ, or grouping differs. Record when the newer state was confirmed at the source and first appeared on the comparison device.

The [delayed-sync timeline](/blog/delayed-sync-after-source-update/) handles the source-to-Norva sequence.

## Match account and profile

Verify the exact Norva account and active profile on both devices. Do not rely on similar avatars or household names. Record whether sign-in or profile selection changed recently. Different profile context can affect history, preferences, and visible state.

## Match source and view controls

Record enabled source labels, availability, category, year, rating, audio, subtitles, search query, sort, and grouped-version state. Clear or align one visible difference at a time. A filter mismatch is a comparison-context result, not evidence that either catalog is wrong.

For count-specific differences, use the [category-count comparison](/blog/category-counts-differ-across-devices/).

## Record software and device context

Capture device model, operating system version, Norva application version, available storage if relevant, foreground or resumed state, and network type. A version difference is worth recording but should not be declared the cause without further evidence.

## Observe close together

Compare both devices within a short documented interval and include timezone. Do not compare a screenshot from yesterday with a live screen today without labeling the gap. If official support publishes timing guidance, use the current statement; otherwise report the interval only.

## Use a privacy-safe sample

Select one recently added entry, one changed entry, and one unchanged control item. Record neutral sample codes, source label, title metadata, year, version, category, artwork state, and presence on each screen. Avoid full catalog screenshots.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) explains how item identity fits the broader layers.

## Check network observations

Confirm ordinary authorized Norva and source pages load on both devices. If practical, compare the affected device on one other trusted network, keeping every other context stable. Do not disable security controls, alter certificate validation, or install unknown network profiles.

## Use documented refresh behavior only

Follow the current Norva support route for any non-destructive refresh, navigation, or sign-in step. Record the time and outcome. Do not invent a hidden refresh control or repeatedly trigger catalog operations.

## Preserve local state before destructive actions

Do not clear application data, erase downloads, reinstall, remove the source, or reset the device as a first test. Those actions can remove progress, session, or diagnostic context and make the original difference impossible to reproduce. Escalate the paired evidence first unless official guidance directs otherwise.

## Classify the result

Use context mismatch, version difference, network-specific observation, device-specific display, source timing difference, item-identity difference, resolved by documented step, or unknown. “Cache problem” is a hypothesis unless current evidence and support establish it.

## Original evidence: cross-screen catalog context matrix

| Context | Device A | Device B | Same? |
| --- | --- | --- | --- |
| Account and profile |  |  |  |
| Sources and filters |  |  |  |
| Category, sort, grouping |  |  |  |
| Device, OS, app version |  |  |  |
| Network and time |  |  |  |
| Displayed count |  |  |  |
| Sample A, B, control |  |  |  |

## Common mistakes and limitations

- Comparing different profiles or source selections.
- Ignoring search, language, category, or grouping controls.
- Comparing observations made far apart without a timeline.
- Clearing data before preserving paired evidence.
- Calling the difference a cache failure without proof.
- Capturing complete private catalogs in screenshots.

## Frequently asked questions

### Should I clear application data first?

No. Align contexts and preserve evidence first. Follow current Norva support guidance before destructive local changes.

### Does an older application version prove the cause?

No. Record it as a context difference and use current supported-version guidance, but keep conclusions evidence-based.

### What should paired evidence include?

Include account and profile confirmation, all visible controls, versions, timestamps, aggregate counts, and the same redacted item samples on both devices.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
