---
content_id: "NVB-421"
title: "A State-by-State Guide to Cross-Device Viewing Handoff"
seo_title: "Cross-Device Viewing Handoff: A State Guide"
meta_description: "Plan a reliable viewing handoff by matching account, profile, source access, item identity, version, position, tracks, output, and target-device state."
slug: "a-state-by-state-guide-to-cross-device-viewing-handoff"
canonical_url: "https://norva.tv/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "pillar-guide"
topic_cluster: "Cross-Device Handoff"
search_intent: "cross-device handoff state model"
funnel_stage: "awareness"
primary_question: "Which states must be verified for a reliable cross-device viewing handoff?"
supporting_questions:
  - "What should be recorded on the source screen?"
  - "What must match on the target device?"
  - "How should a failed handoff be recovered?"
audience:
  - "People moving viewing between supported screens"
  - "Households troubleshooting cross-device continuity"
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
estimated_reading_minutes: 6
excerpt: "Plan a reliable viewing handoff by matching account, profile, source access, item identity, version, position, tracks, output, and target-device state."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/what-must-match-before-a-cross-device-handoff-can-work/"
  - "/blog/how-to-verify-item-identity-before-moving-between-screens/"
  - "/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/"
cta:
  label: "See How Norva Works Across Devices"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://www.w3.org/TR/remote-playback/"
  - "https://www.w3.org/TR/presentation-api/"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "cross-device state ledger"
  summary: "A nine-layer ledger separates account, profile, source, item, version, progress, tracks, output, and device readiness so a handoff can be verified incrementally."
  methodology: "Readers capture source state while paused, rebuild the same state independently on the target, compare each layer, and resume only after critical identity fields match."
  asset_urls: []
---
# A State-by-State Guide to Cross-Device Viewing Handoff

> **In short:** A reliable handoff is not one state; it is a match across account, profile, authorised source access, item identity, version, progress, audio/subtitle choices, output, and target readiness. Pause the source, record those layers, rebuild them on the supported target, verify the timeline, and resume once. Never use artwork or a “continue” card as the only identity check.

Norva states that catalogue, progress, history, favourites, and preferences can follow the same account across supported devices. That continuity supports handoff, but it does not remove differences in device support, source access, local state, audio routes, or available media tracks.

## Define handoff correctly

In this guide, **handoff** means ending or pausing work on one screen and continuing the corresponding item on another supported screen. The target opens its own Norva experience and verifies the account state.

Handoff is not automatically screen mirroring or remote playback. The W3C Presentation API and Remote Playback specification describe separate classes of second-screen behaviour. Their existence does not prove that Norva implements a particular mirroring, casting, or receiver feature.

## The nine state layers

### 1. Device state

Both devices must be supported, operational, and able to open the current Norva experience. A source tablet with low power or a target TV awaiting an update can interrupt the sequence.

### 2. Account state

The same intended account should be available on the target. Do not enter credentials where they can be observed. A device sign-in and a profile selection are different checks.

### 3. Profile state

Choose the profile whose history, progress, favourites, and preferences belong to the viewer. Profile capacity does not define device count or simultaneous playback rights.

### 4. Source state

The target must reach the same compatible media source the user owns or is authorised to use. A catalogue entry visible on one device is not proof that the target can currently access its version.

### 5. Item state

Record full identity: title and year for a film, or series, season, and episode for episodic media. Use [the item identity verification workflow](/blog/how-to-verify-item-identity-before-moving-between-screens/) before leaving the source.

### 6. Version state

If variants are grouped, record the source or version label plus any distinguishing duration, track, or format information shown. Never choose by list position alone.

### 7. Progress state

Pause and note the approximate timestamp or visible progress. On the target, compare the loaded position before resuming. Small manual uncertainty is normal; a large mismatch should trigger identity checks.

### 8. Preference state

Verify audio language and subtitles. Norva can preserve preferences, but the actual tracks available depend on the source and media. A saved preference cannot create an absent track.

### 9. Presentation state

Confirm the target audio output, level, orientation or display mode, and control method. These are device states, not necessarily synchronised account preferences.

## Source-screen procedure

1. Pause at a stable point.
2. Confirm account and profile.
3. Record item, episode, and version.
4. Note approximate position.
5. Record audio and subtitle choices.
6. Leave the item paused until the target is verified.
7. Avoid changing favourites or source data during the transition.

For a series, the [mid-episode handoff workflow](/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/) adds an adjacent-episode check.

## Target-screen procedure

Open Norva through the supported target route. Confirm the account and profile before selecting a continuation card. Search or browse to the recorded item, verify the version, and inspect the proposed position.

Select audio and subtitle tracks from what is actually available. Confirm the sound route at a low comfortable level. Resume once, then check that the timeline advances from the intended scene.

If the item is missing, do not repeatedly refresh or choose a look-alike. Work through [the handoff prerequisites](/blog/what-must-match-before-a-cross-device-handoff-can-work/) one state at a time.

## Original evidence: handoff state ledger

| Layer | Source state | Target state | Match required before resume? |
| --- | --- | --- | --- |
| Supported device |  |  | Yes |
| Account |  |  | Yes |
| Profile |  |  | Yes |
| Authorised source access |  |  | Yes |
| Item/episode |  |  | Yes |
| Version |  |  | Yes |
| Approximate position |  |  | Investigate differences |
| Audio/subtitles |  |  | Match the viewing need |
| Output/control method |  |  | Verify locally |

The ledger is reproducible and intentionally separates synchronised account data from local presentation state.

## Recovery when a state differs

Stop at the first mismatch. If the account is wrong, fix it before touching the item. If the item is wrong, do not adjust progress. If the version differs, compare visible metadata. If only the output differs, pause and correct the local audio route.

Change one state at a time, then repeat the target check. This preserves evidence and avoids turning a simple mismatch into several unknowns.

## Limitations and common mistakes

A handoff can fail because of target support, source availability, rights, network state, expired authentication, incomplete metadata, or a different version. It does not guarantee concurrent playback, identical interfaces, or identical output quality.

Common errors include trusting artwork, selecting the first “continue” item, confusing profile count with device permissions, assuming tracks exist everywhere, and starting the target before pausing the source.

## Frequently asked questions

### Does handoff require both screens to stay active?

Not necessarily. This workflow pauses the source and verifies the target. Any simultaneous-use requirement must be checked separately against current terms and source conditions.

### Is progress the only synchronised state that matters?

No. Profile, item, version, audio, subtitles, source access, and local output can all affect the result.

### What if the target shows the right title but the wrong position?

Stay paused. Confirm profile, episode, and version, then refresh only through documented controls or rebuild the item route.

## Your next step

[See how Norva works across devices](https://norva.tv/#how-it-works)

## Sources

- [W3C Remote Playback API](https://www.w3.org/TR/remote-playback/)
- [W3C Presentation API](https://www.w3.org/TR/presentation-api/)
- [Norva: How It Works](https://norva.tv/#how-it-works)

