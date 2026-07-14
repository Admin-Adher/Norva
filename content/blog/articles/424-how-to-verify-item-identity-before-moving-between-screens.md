---
content_id: "NVB-424"
title: "How to Verify Item Identity Before Moving Between Screens"
seo_title: "Verify Media Identity Before Moving Between Screens"
meta_description: "Verify title, year, series, season, episode, source, version, duration, and tracks before moving a viewing session between supported screens."
slug: "how-to-verify-item-identity-before-moving-between-screens"
canonical_url: "https://norva.tv/blog/how-to-verify-item-identity-before-moving-between-screens/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Cross-Device Handoff"
search_intent: "handoff media identity verification"
funnel_stage: "retention"
primary_question: "How can I verify media item identity before moving between screens?"
supporting_questions:
  - "Which fields are strongest for films and series?"
  - "What should I do when metadata is incomplete?"
audience:
  - "People preparing cross-device handoff"
  - "Viewers comparing similar titles or grouped versions"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Verify title, year, series, season, episode, source, version, duration, and tracks before moving a viewing session between supported screens."
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
  - "/blog/what-must-match-before-a-cross-device-handoff-can-work/"
  - "/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/"
cta:
  label: "Explore Norva's Organising Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "media identity fingerprint"
  summary: "A hierarchy of strong, supporting, and weak identity fields prevents handoff decisions based on poster art, row position, or a single truncated label."
  methodology: "Readers transcribe stable visible fields on the source, compare them independently on the target, and mark every absent field unknown rather than inferred."
  asset_urls: []
---
# How to Verify Item Identity Before Moving Between Screens

> **In short:** Build a small identity fingerprint before leaving the source screen. For films, use full title, year, and version or source label. For series, use series, season, episode number and title, then version. Add duration, tracks, and artwork only as supporting clues. On the target, match the strong fields before comparing progress or pressing play.

A handoff can appear successful while opening a remake, adjacent episode, special, or alternate variant. Progress cannot repair a wrong identity. Verify the media object first.

## Rank identity fields by strength

### Strong fields

For films:

- full title;
- release year when available;
- visible source or grouped-version label.

For series:

- full series title;
- season label;
- episode number;
- episode title when available;
- visible source or version label.

These fields form the core identity. Missing metadata should be marked unknown.

### Supporting fields

Duration, description, audio tracks, subtitle tracks, and format or quality labels can confirm a match. None should be used alone. Different versions can share duration, and the same artwork can cover an entire season.

### Weak fields

Poster art, row position, card colour, the first recommendation, and a generic “continue” label are weak clues. Use them to locate candidates, not to approve the handoff.

W3C guidance on headings, labels, and consistent identification supports interfaces that name and identify controls clearly. The actual source metadata can still be incomplete.

## Source-screen procedure

1. Pause playback.
2. Open or reveal the item detail state.
3. Transcribe the strong identity fields.
4. Record the selected version.
5. Note approximate progress.
6. Add one or two supporting fields.
7. Leave the source paused.

Do not photograph private source URLs, credentials, or account details. A text fingerprint is usually enough.

The [state-by-state handoff guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) places this fingerprint within account, source, preference, and output checks.

## Target-screen procedure

Open the supported Norva route and confirm the intended account and profile. Search or browse using the full title. For a series, enter the series page, select the season, and compare episode number and title.

Then compare version label and supporting fields. Only after the identity passes should you inspect the timeline.

If the first candidate fails one strong field, return and select another. Do not adjust the wrong candidate to resemble the source state.

## Handle incomplete or conflicting metadata

Use a three-value result:

- **match:** all available strong fields agree;
- **uncertain:** a required field is missing or truncated;
- **mismatch:** at least one strong field conflicts.

For an uncertain item, open more detailed metadata, compare the authorised source, or check another supporting field. For a mismatch, stop. The [handoff prerequisite gate](/blog/what-must-match-before-a-cross-device-handoff-can-work/) explains how to return to source and version access.

## Original evidence: identity fingerprint

| Field | Source | Target | Strength | Result |
| --- | --- | --- | --- | --- |
| Full title/series |  |  | Strong |  |
| Year |  |  | Strong for films |  |
| Season |  |  | Strong for series |  |
| Episode number/title |  |  | Strong for series |  |
| Version/source label |  |  | Strong |  |
| Duration |  |  | Supporting |  |
| Audio/subtitles |  |  | Supporting |  |
| Artwork |  |  | Weak |  |
| Approximate progress |  |  | Verify after identity |  |

The fingerprint is intentionally small enough to use during a real handoff. It adds explicit uncertainty instead of converting missing fields into guesses.

## Special case: mid-episode movement

Adjacent episodes may share artwork, duration, and descriptions. Require both episode number and title when available, then compare version and progress. Use [the mid-episode handoff routine](/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/) before resuming.

## Common mistakes and limitations

Avoid identifying by artwork, accepting a truncated title without another field, using progress as primary identity, treating duration as unique, or assuming the first grouped variant is the same one.

Source metadata may be incomplete or inconsistent. This method cannot establish an official release order or correct the source. It only creates a defensible match from visible evidence.

## Frequently asked questions

### Is artwork ever enough to identify an item?

No. Artwork can be reused across versions, seasons, or similarly titled media. Add stable text fields.

### What if the episode has no title?

Use series, season, episode number, version, and supporting duration or description. Mark the missing title unknown.

### Should progress be part of the fingerprint?

Record it, but compare it after item and version identity. A wrong item can still display progress.

## Your next step

[Explore Norva's organising features](https://norva.tv/#features)

## Sources

- [W3C: Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)
- [W3C: Understanding Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html)
- [Norva Features](https://norva.tv/#features)

