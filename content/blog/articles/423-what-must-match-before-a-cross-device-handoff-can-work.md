---
content_id: "NVB-423"
title: "What Must Match Before a Cross-Device Handoff Can Work?"
seo_title: "Cross-Device Handoff Prerequisites to Verify"
meta_description: "Verify supported devices, account, profile, authorised source access, item, version, progress, tracks, and target output before a viewing handoff."
slug: "what-must-match-before-a-cross-device-handoff-can-work"
canonical_url: "https://norva.tv/blog/what-must-match-before-a-cross-device-handoff-can-work/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "checklist"
topic_cluster: "Cross-Device Handoff"
search_intent: "cross-device handoff prerequisites"
funnel_stage: "retention"
primary_question: "What must match before a cross-device viewing handoff can work?"
supporting_questions:
  - "Which states are hard blockers?"
  - "Which preferences can be corrected on the target?"
audience:
  - "People preparing a viewing handoff"
  - "Norva users diagnosing a missing or mismatched continuation"
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
excerpt: "Verify supported devices, account, profile, authorised source access, item, version, progress, tracks, and target output before a viewing handoff."
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
  - "/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/"
cta:
  label: "Learn How Norva Maintains Continuity"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#features"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "handoff prerequisite gate"
  summary: "A blocker-versus-correctable matrix prevents users from troubleshooting audio or layout before device, account, source, item, and version identity are established."
  methodology: "Readers evaluate prerequisites in dependency order, stop at the first blocker, and proceed to local preference checks only after core identity matches."
  asset_urls: []
---
# What Must Match Before a Cross-Device Handoff Can Work?

> **In short:** Five core states must be viable before handoff: a supported target, the intended account and profile, access to the same authorised media source, the same item or episode, and the intended version. Progress, audio, subtitles, and output must then be checked and may be corrected locally. Stop at the first core mismatch.

Handoff troubleshooting becomes inefficient when users start with subtitle size or speaker output while the target is signed into the wrong profile or cannot access the source. Work in dependency order.

## Core prerequisite 1: supported target

The target must be able to open Norva through a currently supported web, mobile, or TV route. “Has a screen” or “uses the same network” is not enough. Verify the current product experience and any required update.

Do not infer support for a specific device brand, store, receiver protocol, or browser without an official source.

## Core prerequisite 2: intended account and profile

Sign in to the intended account and select the profile that owns the viewing context. Norva can preserve progress, history, favourites, and preferences under the same account on supported devices.

A profile allowance is not a simultaneous-playback entitlement or device limit. Check current terms and source conditions for the intended use.

## Core prerequisite 3: authorised source access

The target must reach the compatible media source the user owns or is authorised to use. A title visible in cached history does not prove current access to its media version.

If the source is unavailable, stop. Changing audio, subtitles, or progress will not repair the dependency.

## Core prerequisite 4: exact item identity

Match title plus year for a film. For a series, match series, season, and episode. Use [the cross-screen identity procedure](/blog/how-to-verify-item-identity-before-moving-between-screens/) when metadata is truncated or artwork is similar.

The target's first continuation card is a clue, not proof.

## Core prerequisite 5: intended version

Grouped variants can differ in source label, duration, tracks, availability, or progress. Match the intended variant before comparing the timeline. If the same version is not available, decide whether another authorised version is acceptable rather than silently switching.

## Correctable target states

Once the five core prerequisites pass, inspect:

- approximate playback position;
- audio language;
- subtitle language and on/off state;
- audio output;
- volume;
- orientation or display layout;
- control method.

These states matter to the experience, but many can be adjusted on the target. Available tracks still depend on the source and media.

## Run the gate in order

1. Open the supported target route.
2. Verify account.
3. Verify profile.
4. Confirm source access.
5. Find and verify the item.
6. Match the version.
7. Compare progress.
8. Select available audio and subtitles.
9. Verify output at a low comfortable level.
10. Resume once.

The [state-by-state handoff guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) explains each layer and its recovery path.

## Original evidence: prerequisite gate

| State | Blocker if absent? | Source evidence | Target evidence | Pass? |
| --- | --- | --- | --- | --- |
| Supported target route | Yes |  |  |  |
| Intended account | Yes |  |  |  |
| Intended profile | Yes |  |  |  |
| Authorised source access | Yes |  |  |  |
| Exact item/episode | Yes |  |  |  |
| Intended version | Usually; decide explicitly |  |  |  |
| Approximate position | Investigate difference |  |  |  |
| Audio/subtitles | Correct when available |  |  |  |
| Output/layout | Correct locally |  |  |  |

“Source evidence” and “target evidence” should describe visible fields, not assumptions.

## If one prerequisite fails

Do not skip ahead. For a wrong account, sign out through the documented control. For a missing source, verify authorisation and current availability. For a missing item, search by stable identity fields. For a version mismatch, compare source label, duration, and tracks.

During episodic handoff, use [the mid-episode wrong-item prevention routine](/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/).

## Common mistakes and limitations

Avoid refreshing repeatedly without recording the first state, selecting by artwork, treating a saved preference as proof a track exists, confusing profile count with use permission, and changing progress before matching the version.

This checklist cannot guarantee source availability, network performance, media quality, or support for every target. Product and source conditions can change.

## Frequently asked questions

### Must both devices use the same network?

Do not assume that from cross-device continuity. Follow current product, source, and device requirements for the specific route.

### Is an exact timestamp match required?

A manually recorded time may differ slightly. Investigate a substantial difference by checking profile, episode, and version before seeking.

### What if the target has the item but not the preferred subtitles?

The track may be absent from that version. Review other authorised variants or continue with an available choice; a saved preference cannot add a track.

## Your next step

[Learn how Norva maintains continuity](https://norva.tv/#how-it-works)

## Sources

- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Features](https://norva.tv/#features)
- [Norva Terms](https://norva.tv/terms)
