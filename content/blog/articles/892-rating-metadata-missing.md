---
content_id: "NVB-892"
title: "Rating Metadata Missing? Check Presence Before Presentation"
seo_title: "Rating Metadata Missing? Check Its Source"
meta_description: "Troubleshoot missing rating metadata by comparing item identity, source fields, rating system, views, profile, filters, device, version, timing, and controls."
slug: "rating-metadata-missing"
canonical_url: "https://norva.tv/blog/rating-metadata-missing/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "rating-metadata-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot missing rating metadata?"
supporting_questions:
  - "Which item identity, source rating, rating system, view, profile, filter, device, version, and timing cues should be compared?"
  - "How can content classification and audience score remain distinct?"
audience:
  - "Norva users seeing a missing rating or classification"
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
excerpt: "A rating check first distinguishes content classification from review scores, then compares exact item identity, source fields, Norva views, profile, device, and timing."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/incorrect-release-year-metadata/"
  - "/blog/incorrect-genre-tag/"
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
  type: "rating field presence comparison"
  summary: "A comparison records item and version identity, rating type and system, source field label and value, Norva field by view, profile and filters, device and application version, source confirmation and refresh timeline, and control item."
  methodology: "The user distinguishes classification from score, confirms exact source field presence, freezes context, compares affected and control items, records absence explicitly, and avoids inventing fallback or regional rules."
  asset_urls: []
---

# Rating Metadata Missing? Check Presence Before Presentation

> **In short:** First identify what is missing: an age or content classification, audience score, critic score, star value, or another labeled rating. Confirm the exact item and version, then record the source field label, rating system, value, Norva view, account, profile, filters, device, application version, and timestamp. Compare a control item and preserve absence as evidence without assuming a fallback, regional conversion, or display rule.

“Rating” is ambiguous. A content classification such as an age label serves a different purpose from a review or audience score, and the fields should never be merged in diagnosis.

## Define the rating type

Record the exact label, symbol, scale, and screen where the value is expected. Note whether it is an age classification, advisory, audience score, critic score, star value, or source-specific field. Avoid calling one type a substitute for another.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) provides the field-by-field method.

## Confirm item identity

Compare source label, title code, year, media type, duration, edition, season, episode, language, and version cues. A different regional edition or episode can carry different source metadata.

## Verify source field presence

Through the provider's official authorized route, record whether the rating field exists, its exact label, system, value, and timestamp. If the field is absent, write “not visible in source context” rather than guessing a value.

## Record Norva presentation by view

Check category card, search, detail page, season or episode view, favorite, and grouped version only where the field is relevant. A rating absent from one compact card but visible on a detail page is a presentation difference, not missing source data.

## Freeze profile and filters

Record account, active profile, enabled sources, availability, year, rating filter, category, search, sorting, grouping, device, and application version. A rating filter can change which version or card is visible.

The [release-year guide](/blog/incorrect-release-year-metadata/) helps when the apparent rating difference is tied to another edition.

## Record system and language

Capture the rating system name, country or region only where the source explicitly labels it, and interface language. Do not convert between systems or claim regional selection behavior without current verified documentation.

## Use a control item

Choose one item from the same source, media type, rating system, and view where a value appears normally. Record identical fields. A control confirms the screen can display a rating in that context, but it does not prove why the affected field is absent.

## Preserve the timeline

Record source confirmation, source edit if any, import or refresh, first Norva observation, application update, and current state. Use current support timing only when published. Do not repeat refreshes while assembling the sequence.

## Compare another supported device

Use the same account, profile, source, item, filters, grouping, and close time. Record both application versions. A field visible on one device only is a cross-screen observation, not proof of local storage behavior.

## Avoid manufactured values

Do not add an estimated classification, copy a rating from an unrelated edition, convert a score, or edit source data merely to populate the field. Confirm metadata ownership and authoritative source documentation first.

## Classify the result

Use source field absent, source field present, different rating type, different rating system, different item or version, view-specific absence, profile or filter difference, device-specific presentation, source changed after refresh, or unknown.

## Prepare support evidence

Use the [metadata evidence pack](/blog/metadata-support-evidence-pack/) with item cues, field label and system, source presence, Norva views, context, timeline, and control. The [genre guide](/blog/incorrect-genre-tag/) provides a similar source-versus-presentation separation.

## Original evidence: rating field comparison

| Field | Affected item | Control item |
| --- | --- | --- |
| Item and version identity |  |  |
| Rating type and system |  |  |
| Source field and value |  |  |
| Norva value by view |  |  |
| Profile and filters |  |  |
| Device and app version |  |  |
| Confirmation and refresh time |  |  |

## Common mistakes and limitations

- Mixing age classifications with review scores.
- Comparing different editions or rating systems.
- Treating compact-card absence as global absence.
- Inventing or converting a missing value.
- Ignoring rating filters and profile context.
- Repeating refreshes before preserving the sequence.

## Frequently asked questions

### Can I substitute an audience score for an age rating?

No. They are different labeled concepts. Record the specific missing field and its source system.

### Does source presence guarantee Norva presentation?

Do not assume a guaranteed mapping. Record source and Norva fields independently and use current official documentation.

### Should I copy a rating from another version?

No. Verify exact item, edition, region or system labels, and metadata ownership before any correction.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
