---
content_id: "NVB-426"
title: "How to Move Between Screens When Several Versions Exist"
seo_title: "Move Between Screens With Multiple Media Versions"
meta_description: "Move a viewing session between supported screens by matching item identity, version label, source access, position, audio, and subtitles before resuming."
slug: "how-to-move-between-screens-when-several-versions-exist"
canonical_url: "https://norva.tv/blog/how-to-move-between-screens-when-several-versions-exist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Cross-Device Handoff"
search_intent: "cross-device handoff multiple versions"
funnel_stage: "retention"
primary_question: "How can I move between screens when several versions of the same media item exist?"
supporting_questions:
  - "Which version fields should I record?"
  - "What if the same version is missing on the target?"
audience:
  - "Viewers using grouped media variants"
  - "People preparing a cross-device handoff"
author:
  name: ""
  profile_url: ""
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Move a viewing session between supported screens by matching item identity, version label, source access, position, audio, and subtitles before resuming."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: false
parent_pillar: "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
related_articles:
  - "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
  - "/blog/how-to-verify-item-identity-before-moving-between-screens/"
  - "/blog/how-to-compare-media-versions-on-a-tablet-detail-screen/"
cta:
  label: "Explore Norva's Version Organisation"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html"
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "source-to-target version ledger"
  summary: "A version ledger requires stable item identity, visible version fields, position, and track evidence before playback begins on the target."
  methodology: "Readers pause the source, transcribe only visible metadata for the selected variant, compare it independently on the target, and mark absent fields unknown."
  asset_urls: []
---
# How to Move Between Screens When Several Versions Exist

> **In short:** Pause the source screen and record the base item, selected version or source label, duration, approximate position, audio, and subtitles. On the target, match the base item first and the version second. If the same variant is unavailable, stop and choose explicitly whether another authorised version is acceptable rather than resuming a look-alike.

Grouped versions make a library easier to browse, but they also create a second identity layer. The poster and title may match while duration, tracks, source access, or progress belong to another variant.

## Separate item identity from version identity

The **item** is the film or episode. The **version** is the particular selectable variant presented by the connected source. Confirm them in that order.

For a film, record title and year when available. For a series, record series, season, episode number, and episode title. Then add the visible version or source label. The [cross-screen identity workflow](/blog/how-to-verify-item-identity-before-moving-between-screens/) explains why artwork and row position are weak evidence.

Norva can group variants from a compatible media source you own or are authorised to use. Metadata completeness remains dependent on that source.

## Capture the source version while paused

Record only fields that are actually visible:

- version or source label;
- duration;
- current availability state;
- audio tracks;
- subtitle tracks;
- any quality or format label;
- approximate playback position.

A quality label is descriptive, not an end-to-end performance guarantee. Available audio and subtitles depend on the source and media.

**Observable result:** another person could identify the same candidate without using card position.

## Open the target independently

Use the verified Norva route on the supported target. Confirm the intended account and profile, then find the base item without relying solely on a continuation card.

The [state-by-state handoff guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) places account, profile, authorised source access, and target readiness ahead of version comparison.

## Compare the target candidates

Use a fixed order: version label, duration, tracks, availability, then progress. Mark a field “unknown” if it is missing or truncated. W3C guidance on consistent identification supports stable labelling of repeated functions, but it cannot correct incomplete source metadata.

If multiple target candidates remain indistinguishable, open their detail views one at a time. Do not start each candidate and scrub through it; that can create additional progress states.

## Decide what to do when the version is absent

Choose one of three outcomes:

- **wait:** retain the paused source session and investigate target access;
- **use another version deliberately:** accept different tracks, duration, or progress only after review;
- **end the handoff:** continue on the source screen.

Do not silently substitute a variant. If another version is chosen, treat its timeline as independent until the visible state proves otherwise.

For a tablet comparison, use the [media-version detail-screen matrix](/blog/how-to-compare-media-versions-on-a-tablet-detail-screen/).

## Resume after the match

Compare the approximate target position with the source record. Select available audio and subtitle tracks, verify the target audio output at a low comfortable level, then resume once.

Watch a short section and check the scene, version label, audio, and subtitles again. Leave the source paused until this confirmation succeeds.

## Original evidence: version ledger

| Field | Source screen | Target screen | Result |
| --- | --- | --- | --- |
| Base item identity |  |  | Match / Uncertain / Mismatch |
| Version/source label |  |  |  |
| Duration |  |  |  |
| Audio tracks |  |  |  |
| Subtitle tracks |  |  |  |
| Availability |  |  |  |
| Approximate position |  |  |  |
| Short playback check |  |  |  |

The ledger adds an explicit “uncertain” outcome so missing metadata is not converted into a guess.

## Common mistakes and limitations

Avoid choosing by poster, selecting the first variant, using duration as unique identity, assuming saved preferences create missing tracks, and adjusting progress before matching the version.

Source refreshes, rights, availability, and metadata can change. This workflow improves version matching; it does not guarantee identical variants or immediate synchronisation on every supported device.

## Frequently asked questions

### Is the first grouped version the default one?

Do not infer that from order. Compare the visible fields relevant to the session.

### Can progress move between two different versions?

Treat progress as version-specific until verified in the current interface. Never use it as the only identity field.

### What if the target version has different subtitles?

Decide whether the available target tracks meet the viewing need. A stored preference cannot add an absent subtitle track.

## Your next step

[Explore Norva's version organisation](https://norva.tv/#features)

## Sources

- [W3C: Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)
- [Norva Features](https://norva.tv/#features)
- [Norva: How It Works](https://norva.tv/#how-it-works)

