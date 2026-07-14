---
content_id: "NVB-886"
title: "A Category Is Hidden on One Device: Compare the View Context"
seo_title: "Category Hidden on One Device? Compare Context"
meta_description: "Diagnose a hidden category on one device by matching account, profile, sources, media type, filters, grouping, versions, network, time, and category membership."
slug: "category-hidden-on-one-device"
canonical_url: "https://norva.tv/blog/category-hidden-on-one-device/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "cross-device-category-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose a device-specific hidden category?"
supporting_questions:
  - "Which account, profile, source, media type, filter, grouping, version, network, time, and membership contexts must match?"
  - "Which safe comparisons should happen before device resets?"
audience:
  - "Norva users missing a category on one device"
  - "Households with multiple supported devices"
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
excerpt: "A cross-device category check first aligns account, profile, sources, media type, filters, grouping, versions, network, timing, and membership before changing local state."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/category-counts-differ-across-devices/"
  - "/blog/one-device-shows-old-catalog/"
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
  type: "cross-device category visibility matrix"
  summary: "A matrix compares account, profile, sources, media type, filters, grouping, category label and members, device and application versions, network, timestamp, navigation path, and documented refresh result."
  methodology: "The user aligns both screens, follows the same navigation path, compares category labels and representative members close in time, changes one visible control, and avoids clearing application data before escalation."
  asset_urls: []
---

# A Category Is Hidden on One Device: Compare the View Context

> **In short:** Verify both devices use the same Norva account, profile, authorized sources, media type, availability, filters, search query, sorting, grouping, and navigation path. Record device, operating system, application version, network, close timestamps, category label, displayed count, and representative members. Change one visible control at a time, use only documented refresh behavior, and avoid clearing data, reinstalling, or assuming a local cache cause before paired evidence is saved.

A category visible on one screen but not another is a cross-device observation. It does not yet show whether the difference comes from view context, timing, version, navigation, source membership, or presentation.

Preserve both navigation sequences.

## Define the hidden state

Record whether the category label is absent, appears under another parent section, opens empty, has another localized label, or is outside the visible scroll area. Follow the same navigation path on both devices and note each step.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) separates presentation from source membership.

## Match account and profile

Confirm the exact Norva account and active profile on both devices. Record recent sign-in, profile switch, household role, or device reassignment. Similar profile names or artwork are not enough for a controlled comparison.

## Match sources and media type

Record enabled source labels, availability, category parent, and media type. A film category and a series category may share a label while belonging to different views. Do not assume every device opens the same default section.

## Match every visible control

Align year, rating, audio, subtitles, search query, sorting, and grouping. Remove one mismatch, compare, then restore the baseline. A hidden category after filtering is a view-context result, not proof that its membership disappeared.

If the label appears but has no members, use the [empty-category guide](/blog/empty-category-remains-visible/).

## Compare labels and membership

Record the exact category label on the visible device and search for equivalent wording on the affected screen. Select two privacy-safe member samples and search for them under the same context. Members found elsewhere create different evidence from members absent entirely.

## Record device context

Capture device model, operating system version, Norva application version, network type, foreground or resumed state, and observation time with timezone. An application-version difference is relevant context, but it does not prove the cause.

The [older-catalog cross-screen check](/blog/one-device-shows-old-catalog/) expands the device matrix.

## Compare close in time

Observe both screens within a short recorded interval. Note source updates, imports, syncs, application updates, and profile changes between observations. If official support publishes timing guidance, cite its current statement; otherwise report the interval only.

## Use documented refresh behavior

Follow current Norva support for any non-destructive navigation, refresh, or sign-in step. Record before and after. Do not invent a hidden refresh mechanism or issue repeated imports merely to make the label appear.

## Preserve local state

Do not clear application data, erase downloads, reinstall, reset the device, or remove the source as first tests. Those actions can remove useful session, preference, and diagnostic context. The [category-count comparison](/blog/category-counts-differ-across-devices/) provides a paired table that remains useful to support.

## Classify the difference

Use account or profile mismatch, source or media-type mismatch, filter or grouping difference, navigation-path difference, localized label, timing difference, application-version difference, device-specific presentation, resolved by documented step, or unknown. Avoid claims about cache or storage without verified evidence.

## Original evidence: category visibility matrix

| Context | Device A | Device B | Same? |
| --- | --- | --- | --- |
| Account and profile |  |  |  |
| Sources and media type |  |  |  |
| Filters, sort, grouping |  |  |  |
| Navigation and label |  |  |  |
| Member samples |  |  |  |
| Device, OS, app version |  |  |  |
| Network and timestamp |  |  |  |

## Common mistakes and limitations

- Comparing different profiles or media-type sections.
- Ignoring search, language, or grouping controls.
- Looking only at the label instead of member samples.
- Clearing application data before paired evidence exists.
- Calling the cause a cache failure without proof.
- Comparing screens observed at different source states.

## Frequently asked questions

### Should I reinstall the application first?

No. Align contexts and preserve paired evidence before following any destructive step in current official guidance.

### Does finding the items elsewhere mean the category is healthy?

It proves the entries are visible in another context, not why the category label or membership differs.

### What should support receive?

Send both complete view contexts, versions, close timestamps, exact labels, displayed counts, and a few redacted member samples.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
