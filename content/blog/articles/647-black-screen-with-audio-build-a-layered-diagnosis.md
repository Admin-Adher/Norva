---
content_id: "NVB-647"
title: "Black Screen With Audio: Build a Layered Diagnosis"
seo_title: "Black Screen With Audio: Layered Diagnosis"
meta_description: "Diagnose a black screen with audio by recording UI and captions, title timecode, version, video capability, output path, display state, network context, and recovery."
slug: "black-screen-with-audio-build-a-layered-diagnosis"
canonical_url: "https://norva.tv/blog/black-screen-with-audio-build-a-layered-diagnosis/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "black-screen-diagnostic"
topic_cluster: "Playback Error Diagnostics"
search_intent: "black screen with audio diagnostic"
funnel_stage: "retention"
primary_question: "How should a black screen with continuing audio be diagnosed?"
supporting_questions: []
audience: []
author:
  name: ""
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
  source_of_truth: "https://norva.tv/; https://norva.tv/support; https://norva.tv/privacy; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "Record whether app controls, menus, captions, and the playhead remain visible; whether audio advances or loops; exact title timecode; source version; device; video capability; local or external display path; and recovery. A black video region differs from a black entire display, and continued audio does not prove the network is healthy."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "black-screen layer isolation matrix"
  summary: "A matrix records UI visibility, captions, picture state, advancing audio, playhead, title timecode, source version, video capability, local and external output, display state, network evidence, recurrence, and recovery."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/how-to-read-a-playback-error-before-trying-a-fix/"
related_articles:
  - "/blog/audio-continues-but-video-stalls-record-the-difference/"
  - "/blog/picture-but-no-sound-identify-the-missing-layer/"
  - "/blog/how-to-investigate-an-unsupported-media-message/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/media-capabilities/"
  - "https://www.w3.org/TR/media-source-2/"
  - "https://www.w3.org/TR/remote-playback/"
---
# Black Screen With Audio: Build a Layered Diagnosis

> **In short:** Record whether app controls, menus, captions, and the playhead remain visible; whether audio advances or loops; exact title timecode; source version; device; video capability; local or external display path; and recovery. A black video region differs from a black entire display, and continued audio does not prove the network is healthy.

Start at safe brightness and volume. Do not repeatedly power-cycle a display or unplug active cables without official guidance.

## Define what is black

Is only the video rectangle black while controls remain? Does the entire display lose picture? Are menus, captions, overlays, or another input visible? Record backlight or status indicators only as observations.

This distinction separates app rendering from whole-display or input-path clues.

## Verify audio advancement

Note whether dialogue or music advances into new content, repeats, drops, or becomes unsynchronized. Record the visible playhead and captions. [Audio continuing while video stalls](/blog/audio-continues-but-video-stalls-record-the-difference/) supplies a dual-clock log.

Use safe volume and do not diagnose from a brief loop mistaken for progress.

## Record media context

Capture authorised source, exact title version, video quality, audio and subtitle tracks, dynamic range, playback phase, timecode, and any error. Check whether another title and an alternate legitimate version display picture.

Do not share source URLs, tokens, or copyrighted frames publicly.

## Original evidence: layer matrix

| Layer | Baseline observation | One comparison | Result |
|---|---|---|---|
| App UI/captions/playhead | Visible/hidden/advancing | Another title | Outcome |
| Video/audio content | Black/advancing/looping | Alternate version | Outcome |
| Device capability | Verified/unknown | Another device | Outcome |
| Output/display | Local/external/input | Local output | Outcome |
| Network/source | Path and metrics | Another path/time | Outcome |
| Recovery | Wait/seek/restart | Controlled action | Recurrence |

Keep interpretation separate from observations and record manual timing limits.

## Test local versus external output

If remote playback, an external display, receiver, adapter, or cable is active, test the player's supported local output once. Verify input selection and official cable seating procedures. Restore calibrated picture, accessibility, and output settings afterward.

W3C Remote Playback describes a web remote-playback model, not every casting or display architecture.

## Compare media capability

Record verified codec, profile, resolution, frame rate, dynamic range, and output compatibility. W3C Media Capabilities provides contextual questions in supported implementations. [The unsupported-media guide](/blog/how-to-investigate-an-unsupported-media-message/) builds the version matrix.

Do not conclude that the decoder failed solely because audio continues.

## Replay the event

Start before the exact timecode and keep version, tracks, output, and path fixed. If black appears at the same point across devices, source or media specifics gain relevance. If it follows one output, display-path compatibility gains relevance.

Limit repeats and stop if the display reports protection, temperature, or hardware warnings.

## Include network and source evidence

Record route, throughput range, delay variation, loss evidence, and source status. Audio and video may have different data rates or processing paths; one track continuing cannot clear delivery.

W3C Media Source Extensions provides coded-media and buffering vocabulary for compatible web players, but do not infer hidden ranges without diagnostics.

## Try narrow recovery

Wait for a defined interval, show and hide controls, pause and resume once, then restart only the app after evidence capture. Follow official display and app support for handshake or protection messages. Avoid factory reset, service menus, and unofficial firmware.

[Picture without sound](/blog/picture-but-no-sound-identify-the-missing-layer/) uses the inverse layer test.

## Report the pattern

Include exactly what is black, UI and caption state, audio advancement, version, timecode, capability, output, display, network, comparison results, recovery, and unknowns. Norva plays compatible authorised sources but cannot certify media, decoder, output, or display behavior.

## Frequently asked questions

### Does audio prove the title is fully downloaded?

No. Audio and video delivery, buffering, decoding, and rendering can differ.

### Should picture settings be reset?

No. First check whether UI and other inputs are visible; preserve calibration and change one documented control only.

### Can a cable cause black video with audio?

An external output path can affect components differently, but use official diagnostics and a supported comparison before blaming a cable.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C Media Source Extensions](https://www.w3.org/TR/media-source-2/)
- [W3C Remote Playback API](https://www.w3.org/TR/remote-playback/)