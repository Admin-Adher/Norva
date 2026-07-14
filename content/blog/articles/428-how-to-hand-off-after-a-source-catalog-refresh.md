---
content_id: "NVB-428"
title: "How to Hand Off After a Source Catalog Refresh"
seo_title: "Hand Off Safely After a Source Catalog Refresh"
meta_description: "After a source catalogue refresh, re-verify item identity, grouped versions, availability, progress, audio, and subtitles before moving playback to another screen."
slug: "how-to-hand-off-after-a-source-catalog-refresh"
canonical_url: "https://norva.tv/blog/how-to-hand-off-after-a-source-catalog-refresh/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Cross-Device Handoff"
search_intent: "handoff after source refresh"
funnel_stage: "retention"
primary_question: "How should I hand off a viewing session after the connected source catalogue refreshes?"
supporting_questions:
  - "Which metadata may need rechecking?"
  - "What if the previous version is no longer visible?"
audience:
  - "Viewers handing off after source changes"
  - "People troubleshooting changed grouped versions"
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
excerpt: "After a source catalogue refresh, re-verify item identity, grouped versions, availability, progress, audio, and subtitles before moving playback to another screen."
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
  - "/blog/how-to-move-between-screens-when-several-versions-exist/"
  - "/blog/what-must-match-before-a-cross-device-handoff-can-work/"
cta:
  label: "See How Norva Organises Your Source"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "pre-refresh and post-refresh identity diff"
  summary: "A visible diff separates changed source metadata from unchanged viewing intent before a target screen is allowed to resume."
  methodology: "Readers capture item and version fields before or immediately after refresh, compare the refreshed source view, and rebuild the verified state on the target."
  asset_urls: []
---
# How to Hand Off After a Source Catalog Refresh

> **In short:** Treat a source catalogue refresh as a new identity check. Pause playback, reopen the item, and verify title, episode, grouped versions, availability, duration, audio, subtitles, and progress before using another screen. If the previous variant is missing or relabelled, do not substitute it silently; decide whether the available candidate is truly acceptable.

A refresh can change what the connected source presents to Norva. Artwork, labels, grouped variants, or availability may look different even when the viewer's intent has not changed. The safe handoff begins from the refreshed state, not an old card remembered from before.

## Establish the refresh boundary

Record what triggered the review: a manual source refresh, a changed catalogue view, a newly visible variant, or a missing item. Do not claim that Norva altered the underlying source. Norva organises a compatible media source the user owns or is authorised to use.

Pause the current session and avoid changing favourites, filters, or progress while identity is unresolved.

Use the [full handoff state model](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) to keep the pre-refresh source record separate from the target state.

## Reopen the item from the library

Return to the stable library section and find the item using full title plus year, or series, season, and episode. Do not rely on a cached continuation card.

W3C information-and-relationships guidance supports preserving meaningful structure, but the actual metadata comes from the source and may be incomplete.

**Observable result:** the refreshed detail screen still represents the intended base item.

## Rebuild the version list

Write down every currently visible variant and its distinguishing fields:

- source or version label;
- duration;
- availability;
- audio;
- subtitles;
- quality or format label if shown.

Compare this list with the previously selected version. Use [the multiple-version handoff workflow](/blog/how-to-move-between-screens-when-several-versions-exist/) when several candidates remain.

## Verify progress separately

Only after item and version identity match should you inspect the visible position. A refreshed card may point to a different variant or episode. Record both the old known position and the refreshed position without seeking.

If the refreshed source screen no longer exposes the intended version, progress on another candidate is not enough to prove equivalence.

## Decide among three outcomes

- **Proceed:** identity and version remain clear, and position is plausible.
- **Proceed with a different version:** the viewer explicitly accepts changed tracks or timeline behaviour.
- **Stop:** source access, identity, or version is unresolved.

The [handoff prerequisite gate](/blog/what-must-match-before-a-cross-device-handoff-can-work/) treats authorised source access and exact item identity as blockers.

## Build the target from refreshed evidence

Open the supported target and confirm account and profile. Find the item and compare it with the refreshed source record, not the pre-refresh memory. Match version, then progress, then audio and subtitles.

Resume once and verify a short section. Keep the source paused until the target's item and tracks are confirmed.

## Original evidence: refresh diff

| Field | Before/last known state | Refreshed source state | Target state |
| --- | --- | --- | --- |
| Base item identity |  |  |  |
| Episode identity |  |  |  |
| Version/source label |  |  |  |
| Duration |  |  |  |
| Availability |  |  |  |
| Audio/subtitles |  |  |  |
| Approximate progress |  |  |  |
| Decision |  |  |  |

Mark any changed field and explain whether it affects identity, preference, or only presentation. This prevents a cosmetic difference from being confused with a media mismatch.

## If the item disappears

Stop the handoff. Verify the connected source's current availability and the user's authorisation. Do not create a duplicate entry, change account data, or select a similarly titled item to bypass the absence.

For a persistent discrepancy, document the source and target states without including credentials or private source URLs.

## Common mistakes and limitations

Avoid using old screenshots as current truth, trusting a continuation card after refresh, treating a relabelled variant as identical without evidence, and adjusting progress before identity.

Source metadata and availability can change outside Norva. This workflow does not restore missing media, correct source records, or guarantee that a previous variant remains available.

## Frequently asked questions

### Does a source refresh erase progress?

Do not assume it does. Compare the same profile, item, and version before interpreting a changed position.

### What if only the artwork changed?

Use text identity, version, duration, and track fields. Artwork is supporting evidence, not a stable identifier.

### Can I hand off to another version?

Only as an explicit choice after reviewing tracks, duration, progress, source access, and viewing needs.

## Your next step

[See how Norva organises your source](https://norva.tv/#how-it-works)

## Sources

- [W3C: Understanding Info and Relationships](https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships.html)
- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Features](https://norva.tv/#features)
