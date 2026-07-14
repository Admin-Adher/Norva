---
content_id: "NVB-646"
title: "How to Investigate an Unsupported-Media Message"
seo_title: "How to Investigate Unsupported Media Errors"
meta_description: "Investigate unsupported-media messages through code, title version, verified container and codecs, tracks, device, app, OS, output, capability, and recurrence."
slug: "how-to-investigate-an-unsupported-media-message"
canonical_url: "https://norva.tv/blog/how-to-investigate-an-unsupported-media-message/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "unsupported-media-diagnostic"
topic_cluster: "Playback Error Diagnostics"
search_intent: "unsupported media playback diagnostic"
funnel_stage: "retention"
primary_question: "How should an unsupported-media message be investigated?"
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
excerpt: "Preserve the exact message and code, then record the authorised title version, container, video and audio codecs and profiles, resolution, frame rate, dynamic range, channels, tracks, protection context, device, app, operating system, and output. Compare an officially supported version and another supported device without renaming or modifying the source."
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
  type: "media capability and version matrix"
  summary: "A matrix records exact message, container, codecs and profiles, resolution, frame rate, dynamic range, audio channels, tracks, protection, device, app, OS, output, official capability, alternate version, and recurrence."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/how-to-read-a-playback-error-before-trying-a-fix/"
related_articles:
  - "/blog/build-a-plain-english-taxonomy-of-playback-error-messages/"
  - "/blog/media-unavailable-separate-temporary-and-persistent-cases/"
  - "/blog/black-screen-with-audio-build-a-layered-diagnosis/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/media-capabilities/"
  - "https://www.w3.org/TR/media-source-2/"
  - "https://www.w3.org/TR/encrypted-media/"
---
# How to Investigate an Unsupported-Media Message

> **In short:** Preserve the exact message and code, then record the authorised title version, container, video and audio codecs and profiles, resolution, frame rate, dynamic range, channels, tracks, protection context, device, app, operating system, and output. Compare an officially supported version and another supported device without renaming or modifying the source.

“Unsupported” can refer to a complete combination, not one codec. A device may support a video format at some profiles or resolutions but not others.

## Capture message and phase

Transcribe the original wording, code, language, buttons, timestamp, and whether failure occurs during selection, startup, track change, seeking, handoff, or output change. Record whether another title plays.

[The error taxonomy](/blog/build-a-plain-english-taxonomy-of-playback-error-messages/) keeps capability separate from availability and session state.

## Verify media metadata

Use a trusted source or approved inspection tool to record container, codecs, profile or level where exposed, resolution, frame rate, pixel format, dynamic range, audio format, sample rate, channel layout, subtitle format, and protection state. Mark missing values unknown.

Do not upload copyrighted media or source credentials to public analysis services.

## Check the complete device path

Record device model, app and operating-system versions, local or remote playback, external display, receiver, adapter, cable, and audio route. Output capability can change the supported combination.

W3C Media Capabilities exposes contextual decoding questions for supported web implementations; official product specifications still govern the actual case.

## Original evidence: capability matrix

| Field | Failing version | Supported control | Evidence source |
|---|---|---|---|
| Container/video codec/profile | Values | Values | Verified/unknown |
| Resolution/frame rate/range | Values | Values | Source |
| Audio/channels/tracks | Values | Values | Source |
| Protection/output | Context | Context | Official status |
| Device/app/OS | Context | Same/different | Official support |
| Message/phase | Verbatim | Result | Observation |
| Alternate device/version | Result | Result | Recurrence |

Do not reduce the comparison to filename extension; extension is not complete media capability evidence.

## Compare an authorised version

If the source offers another legitimate version, change one property at a time where possible: video version, audio track, subtitle track, or output. Record every verified difference. [Unavailable and unsupported are different states](/blog/media-unavailable-separate-temporary-and-persistent-cases/).

Do not download, convert, or redistribute media without authorization.

## Compare another device

Test the same version on another supported device and the same device with a matched control. If the exact version fails only on one platform, capability or app path gains relevance. If it fails everywhere, source version or protection context gains relevance.

These comparisons do not prove that the media itself violates a standard.

## Consider protection and policy

W3C Encrypted Media Extensions specifies APIs for interaction with content-protection systems in supported web contexts. A message may involve authorization, output protection, or implementation policy rather than decoding alone.

Do not bypass protection, region, account, or device policy. Use official source and device support.

## Separate parse, decode, and output

W3C Media Source Extensions describes coded-media processing for compatible implementations. An app may reject metadata, fail while processing coded frames, or encounter an output limit. Unless official diagnostics distinguish them, report only “unsupported-media message at startup” or the observed phase.

[The black-screen-with-audio guide](/blog/black-screen-with-audio-build-a-layered-diagnosis/) covers cases where playback begins partially.

## Use safe recovery

Check official compatibility lists, supported updates, and known issues. Restart the app after evidence capture. Change to a supported authorised version through normal controls. Avoid codec packs, unofficial firmware, service menus, and random file renaming.

After recovery, return once to the original version and confirm whether the message remains. Record an inconclusive or changed result instead of assuming the update, output switch, or alternate version corrected one specific internal component.

Norva organises and plays compatible authorised sources. Current supported formats vary by web, mobile, TV, operating system, device, and source and must be verified officially.

## Frequently asked questions

### Does changing a file extension make media supported?

No. It does not convert the container, codecs, profiles, tracks, or protection.

### Does codec support guarantee every file plays?

No. Profile, level, resolution, frame rate, range, audio, container, output, and implementation limits matter.

### Should an unofficial codec package be installed?

No. Use trusted platform updates and official compatibility guidance.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [W3C Media Source Extensions](https://www.w3.org/TR/media-source-2/)
- [W3C Encrypted Media Extensions](https://www.w3.org/TR/encrypted-media/)