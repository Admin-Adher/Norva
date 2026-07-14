---
content_id: "NVB-888"
title: "Wrong Release Year? Verify the Exact Version First"
seo_title: "Wrong Release Year? Verify the Version"
meta_description: "Troubleshoot wrong release-year metadata by confirming item identity, source version, media type, edition, year fields, device context, timing, and samples."
slug: "incorrect-release-year-metadata"
canonical_url: "https://norva.tv/blog/incorrect-release-year-metadata/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "release-year-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot incorrect release year metadata?"
supporting_questions:
  - "Which item, source, version, media type, edition, year, device, and timing cues should be compared?"
  - "How can release, broadcast, season, and edition years remain distinct?"
audience:
  - "Norva users seeing an unexpected release year"
  - "Household metadata administrators"
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
excerpt: "A release-year check verifies the exact item and source version, then compares each visible year field, media type, edition, device context, and timeline before correction."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/runtime-differs-between-versions/"
  - "/blog/grouped-versions-wrong-title/"
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
  type: "release year version verification card"
  summary: "A card records item and source version cues, media type, edition, season and episode where relevant, source year fields, Norva year by view, duration, language, device and application version, and timeline."
  methodology: "The user confirms exact identity, records each year field separately at source and in Norva, compares one control version, avoids edits before baseline capture, and sends a redacted evidence card."
  asset_urls: []
---

# Wrong Release Year? Verify the Exact Version First

> **In short:** Confirm the same logical item and source version before calling a year wrong. Record source label, title code, media type, edition, season or episode, duration, language cues, every visible source year field, Norva year by view, device, application version, and timestamp. Compare an alternate version and a control item, preserve the original metadata, and avoid assuming release, broadcast, season, production, or edition years are interchangeable.

A year can describe theatrical release, first broadcast, season, episode, production, remaster, restored edition, or source publication. The visible label and exact version determine whether two values are truly contradictory.

Preserve the complete field label because a bare number loses the meaning required for comparison.

## Confirm item identity

Compare title, source, media type, duration, edition, artwork, season, episode, language, and version cues. Same-title items can be remakes or alternate cuts. Do not request a year correction until identity is stable.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) provides the identity matrix.

## Record each source year field

Through the provider's official authorized route, capture the field label and value: release, aired, season, episode, production, edition, or another term the provider exposes. Do not collapse them into one “source year.”

## Record the Norva year by view

Note the year shown in category cards, search, detail pages, season lists, episode lists, favorites, and grouped versions only where relevant. A view-specific difference is distinct from one year displayed everywhere.

## Compare version and runtime

Record duration and edition cues for each candidate version. A restored or extended edition may carry a different visible year or source record. The [runtime comparison](/blog/runtime-differs-between-versions/) helps prevent same-title versions from being merged in the investigation.

## Compare series boundaries

For series, distinguish series premiere, season year, and episode air date. Record season and episode numbers with the year. Do not apply the series start year to every episode or assume a season label describes broadcast order.

## Preserve language and title cues

A localized title may refer to another regional release or record. Record original and localized titles, interface language, and source language. Use the [localized-title comparison](/blog/localized-title-mismatch/) when title and year both differ.

## Freeze view context

Record account, profile, enabled sources, filters, grouping, device, operating system, application version, and timestamp. Ensure the comparison did not switch to another source version after a filter or grouped-card change.

## Build the timeline

Record source confirmation, any source metadata edit, import or refresh, first Norva observation, application update, and current state. Timing does not prove which field Norva selected. Use published official timing only when available.

## Use a control item

Choose one item from the same source and media type whose source and Norva year visibly agree. Record its field labels and views. A healthy control limits scope but does not prove the affected item's cause.

## Avoid premature edits

Do not replace the source year, rename the item, merge versions, repeat imports, or clear application data before preserving evidence. Confirm who owns the metadata and whether the provider supports correction. A correction may not persist through later source updates.

## Classify the mismatch

Use different item, alternate edition, different year field, series versus season or episode year, localized release, view-specific value, device-specific value, source changed after import, or unknown. The [wrong-title grouping guide](/blog/grouped-versions-wrong-title/) applies if versions appear under an incorrect parent card.

## Original evidence: release year verification card

| Field | Source | Norva | Control version |
| --- | --- | --- | --- |
| Item and version cues |  |  |  |
| Media type and edition |  |  |  |
| Year field label |  |  |  |
| Year value |  |  |  |
| Duration and language |  |  |  |
| View, device, version |  |  |  |
| Timestamp |  |  |  |

## Common mistakes and limitations

- Matching different versions by title alone.
- Treating every year field as release year.
- Confusing series, season, and episode dates.
- Editing source metadata before preserving the baseline.
- Assuming timing reveals field selection logic.
- Sending complete catalog data for one year mismatch.

## Frequently asked questions

### Which year is correct for an extended edition?

Record the exact edition and each labeled source field. Use authoritative source documentation rather than choosing a value from title alone.

### Does a different runtime matter?

Yes as identity evidence. It may indicate another cut or source version, but it does not alone determine the proper year.

### Should I correct the source immediately?

No. Preserve the original fields, confirm ownership and exact version, and follow provider and Norva support guidance.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
