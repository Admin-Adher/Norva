---
content_id: "NVB-897"
title: "Season Artwork Is Inconsistent: Compare Scope and Source"
seo_title: "Season Artwork Inconsistent? Compare Scope"
meta_description: "Troubleshoot inconsistent season artwork by comparing series and season identity, source images, views, profile, device, version, network, timing, and controls."
slug: "season-artwork-inconsistent"
canonical_url: "https://norva.tv/blog/season-artwork-inconsistent/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "season-artwork-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot inconsistent season artwork?"
supporting_questions:
  - "Which series, season, source image, view, profile, device, version, network, and timing contexts should be compared?"
  - "How can series posters and season-specific artwork remain distinct?"
audience:
  - "Norva users seeing inconsistent season images"
  - "Household series metadata administrators"
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
excerpt: "A season-artwork comparison distinguishes series poster, season image, episode still, and fallback observations while preserving source, view, device, network, and timing context."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/missing-poster-artwork/"
  - "/blog/seasons-missing-after-series-import/"
  - "/blog/metadata-support-evidence-pack/"
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
  type: "season artwork scope comparison"
  summary: "A comparison records exact series and season identity, source series and season image states, Norva artwork by view, image role, profile, filters, device and application version, network, source edit and refresh timeline, and control season."
  methodology: "The user distinguishes image roles, confirms source images for affected and control seasons, freezes context, compares another device and network, and avoids replacing source artwork before baseline capture."
  asset_urls: []
---

# Season Artwork Is Inconsistent: Compare Scope and Source

> **In short:** Confirm the exact series version and season, then distinguish series poster, season artwork, episode still, background, and generic image. Record source image fields, Norva image by view, account, profile, filters, grouping, device, application version, network, source edit and refresh times, and one control season. Compare another supported device, preserve the original images, and avoid assuming how Norva selects, crops, falls back, or stores artwork.

Inconsistent artwork can mean one season is blank, seasons reuse the series poster, images differ across views, or two devices show different pictures. Each is a separate observable state.

## Confirm series and season identity

Record source label, series title code, year, edition, language, season label, representative episodes, and grouped-version state. An alternate series version or renamed season can carry different image data.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) provides the identity matrix.

## Name each image role

Label the observed image as series poster, season poster, season background, episode still, card thumbnail, detail background, or generic fallback only when the interface or source makes that role clear. Do not compare unlike image roles as a mismatch.

## Verify source artwork by scope

Through the provider's official authorized route, record whether the series and each sampled season have distinct visible images. Note field label, image state, and confirmation time. Do not copy private image addresses or infer how Norva retrieves images.

## Record Norva artwork by view

Capture the image state in series card, detail header, season selector, episode list, search, favorite, and progress row only where relevant. A season image used in one view and a series image used in another is a view difference, not automatically an error.

## Compare affected and control seasons

Choose one affected season, an adjacent season, and one control season whose source and Norva images appear consistent. Record exact season labels and representative episode cues. Avoid exporting every season image.

If seasons themselves are missing, use the [season gap map](/blog/seasons-missing-after-series-import/) before diagnosing artwork.

## Freeze view context

Record account, profile, enabled sources, availability, filters, search, sorting, grouping, device, operating system, application version, network, and timestamp. Ensure the view did not switch series versions.

## Compare another supported device

Use the same account, profile, series version, season, filters, grouping, and close time. Record both application versions and networks. A different image on one device is cross-screen evidence, not proof of cache behavior.

The [poster checklist](/blog/missing-poster-artwork/) provides the paired image-state table.

## Compare one trusted network

If artwork is blank only on one screen, compare the affected device on another trusted network while holding every other context stable. Do not disable certificate validation, privacy controls, filtering, or install unknown profiles.

## Preserve the timeline

Record source image edit and confirmation, import or refresh, visible state, first Norva observation, device comparison, and current result. An image changing later establishes timing, not selection or storage logic.

## Avoid image replacement first

Do not replace, rename, resize, or relocate series or season images, repeat imports, clear application data, or reinstall before saving evidence. Confirm source ownership and provider support for edits.

## Classify the inconsistency

Use different image roles, source season image absent, source image present, series image reused, one-view difference, one-device difference, network-specific observation, wrong series or season identity, generic fallback, or unknown. Do not invent crop, priority, fallback, or caching rules.

## Prepare support evidence

Use the [metadata evidence pack](/blog/metadata-support-evidence-pack/) with series and season cues, image roles, source and Norva states, control season, context, devices, networks, and timeline.

## Original evidence: season artwork comparison

| Field | Affected season | Control season | Other device |
| --- | --- | --- | --- |
| Series and season identity |  |  |  |
| Image role |  |  |  |
| Source image state |  |  |  |
| Norva image by view |  |  |  |
| Profile, filters, grouping |  |  |  |
| Device, version, network |  |  |  |
| Edit and refresh time |  |  |  |

## Common mistakes and limitations

- Comparing series posters with season or episode images.
- Comparing different series versions or season labels.
- Replacing source artwork before evidence capture.
- Calling a cross-device difference cache behavior.
- Disabling network security to load images.
- Inferring undocumented image priority or fallback rules.

## Frequently asked questions

### Should every season have unique artwork?

Do not assume a requirement that current source or Norva documentation does not state. Record each image role and source field.

### Does a reused series poster prove season artwork is missing?

No. Confirm whether a season-specific source image exists and record the Norva view separately.

### Should I upload replacement images?

Not before preserving the baseline, confirming metadata ownership, and following provider and Norva support guidance.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
