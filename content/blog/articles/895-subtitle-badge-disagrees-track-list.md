---
content_id: "NVB-895"
title: "Subtitle Badge Disagrees With the Track List: A Verification Path"
seo_title: "Subtitle Badge and Track List Disagree"
meta_description: "Troubleshoot subtitle badge and track-list mismatches by comparing exact version, badges, visible tracks, labels, profile, device, app version, and timing."
slug: "subtitle-badge-disagrees-track-list"
canonical_url: "https://norva.tv/blog/subtitle-badge-disagrees-track-list/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "subtitle-metadata-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot a subtitle badge and track-list mismatch?"
supporting_questions:
  - "Which version, badge, pre-playback, playback, label, profile, device, and timing evidence should be compared?"
  - "How can forced, full, commentary, and accessibility labels remain distinct?"
audience:
  - "Norva users seeing conflicting subtitle cues"
  - "Multilingual and accessibility-focused households"
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
excerpt: "A subtitle verification pairs the exact source version with its badge, visible track lists before and during authorized playback, track labels, profile, device, application version, and time."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/localized-title-mismatch/"
  - "/blog/audio-badge-disagrees-track-list/"
  - "/blog/metadata-support-evidence-pack/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.w3.org/TR/webvtt1/"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "subtitle badge and track evidence table"
  summary: "A table records exact item and source version, subtitle badges by view, source subtitle fields, pre-playback and in-playback track lists where visible, forced or descriptive labels, selected state, profile, device and application version, and timestamp."
  methodology: "The user freezes version identity, transcribes labels literally, checks authorized playback only when needed, preserves progress, compares another device, and separates badge, track availability, selection, and rendered-text observations."
  asset_urls: []
---

# Subtitle Badge Disagrees With the Track List: A Verification Path

> **In short:** Confirm the exact source version, then record subtitle badges on cards and detail views, source subtitle fields, pre-playback tracks, tracks visible during authorized playback, selected or off state, forced, full, commentary, descriptive, or accessibility labels, profile preference, device, application version, and timestamp. Preserve each label literally, compare another supported device, and never infer a complete subtitle inventory or rendering behavior from a compact badge.

A subtitle badge, available track list, selected state, and text actually rendered during playback are four different observations. Keeping them separate prevents a presentation mismatch from becoming an unsupported playback claim.

## Confirm version identity

Record source label, title code, year, media type, duration, edition, season, episode, language cues, and grouped-version state. Alternate versions can expose different subtitle files while sharing title and artwork.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) provides the identity matrix.

## Record badges by view

Capture exact badge text on category card, search, detail page, episode list, and grouped-version card where shown. Note abbreviations, separators, order, “multi” wording, or absent badge. Do not translate the badge into a guessed track list.

## Record source subtitle fields

Through the provider's official authorized route, transcribe visible subtitle or caption fields for the same version. Keep language codes, regional labels, forced, commentary, descriptive, and accessibility terms separate. Do not assume every field is exposed to Norva.

## Record pre-playback tracks

If a list appears before playback, record each label, default selection, and off option. Include profile, interface language, filters, and source version. Absence from that list does not prove a track cannot appear in another authorized context.

## Record in-playback tracks

When authorized playback is appropriate, open the subtitle control without advancing content unnecessarily. Record visible labels, selection, and timestamp. Do not cycle every track or expose household history. Preserve existing progress.

## Separate selection from rendering

A selected track may not immediately establish what text is rendered throughout the media. If a short authorized check is necessary, record only whether text appears at the observed moment and the timestamp. Do not copy subtitle text or judge the whole track from one scene.

## Keep labels literal

Record “French,” “fr-FR,” “Forced,” “SDH,” “CC,” “Commentary,” “Off,” or unknown exactly as shown. WebVTT defines a web text-track format, but its specification does not reveal which format or metadata path Norva uses for a particular source.

## Freeze profile and device context

Record account, profile subtitle preference where visible, interface language, filters, grouping, device, operating system, application version, and time. A preference or selected state can differ without proving the badge changed.

## Compare another supported device

Use the same account, profile, source version, and close timestamp. Record both application versions. A differing track list is cross-screen evidence, not proof of a particular local or source cause.

## Keep audio evidence separate

Audio languages do not prove subtitle availability. If the audio badge also disagrees, use the [audio verification guide](/blog/audio-badge-disagrees-track-list/) and maintain separate tables. The [localized-title guide](/blog/localized-title-mismatch/) keeps interface and title language separate too.

## Avoid source edits first

Do not rename subtitle tracks, alter codes, replace files, edit the badge, repeat imports, or clear application data before saving the baseline. Confirm ownership and current support guidance.

## Classify the mismatch

Use different source version, badge differs by view, source fields differ, pre-playback list differs, in-playback list differs, selected-state difference, rendering observation differs, profile preference, device-specific presentation, ambiguous label, or unknown. Do not invent badge-generation or track-selection behavior.

## Prepare support evidence

Use the [metadata evidence pack](/blog/metadata-support-evidence-pack/) with item cues, badges, track tables, selection, profile, device versions, timestamps, and one minimal rendering observation when relevant.

## Original evidence: subtitle badge and track table

| Evidence | Value |
| --- | --- |
| Item and source version |  |
| Card and detail badge |  |
| Source subtitle fields |  |
| Pre-playback track list |  |
| In-playback track list |  |
| Selected state and rendering observation |  |
| Profile, device, app version, time |  |

## Common mistakes and limitations

- Treating a badge as a guaranteed track inventory.
- Comparing different source versions.
- Mixing audio and subtitle evidence.
- Treating selected state as proof of complete rendering.
- Normalizing forced or accessibility labels without documentation.
- Changing tracks and progress excessively during testing.

## Frequently asked questions

### Which list best shows available playback options?

Record the in-playback list for the exact authorized version and context, while keeping badge and source fields as separate evidence.

### Does “Multi” guarantee a particular subtitle language?

Do not infer an undefined set. Record exact visible track labels and current official documentation.

### Should I rename subtitle tracks at the source?

Not before preserving evidence, confirming metadata ownership, and following provider and Norva support guidance.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [W3C WebVTT](https://www.w3.org/TR/webvtt1/)
