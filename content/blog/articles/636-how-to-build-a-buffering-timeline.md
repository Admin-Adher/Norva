---
content_id: "NVB-636"
title: "How to Build a Buffering Timeline"
seo_title: "How to Build a Useful Video Buffering Timeline"
meta_description: "Align wall time, elapsed playback, title timecode, A/V behavior, player messages, source version, network path, metrics, household activity, recovery, and recurrence."
slug: "how-to-build-a-buffering-timeline"
canonical_url: "https://norva.tv/blog/how-to-build-a-buffering-timeline/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "buffering-evidence-protocol"
topic_cluster: "Buffering Diagnostics"
search_intent: "buffering event timeline"
funnel_stage: "retention"
primary_question: "How can a useful buffering timeline be built?"
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
excerpt: "Use three clocks: local wall time with time zone, elapsed time since playback began, and title timecode. Add picture, audio, controls, messages, source version, device, route, network samples, household activity, quality state, recovery action, and uncertainty. Record before changing anything and repeat the same case once."
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
  type: "three-clock buffering timeline"
  summary: "A timeline aligns wall clock, elapsed playback and title timecode with picture, audio, controls, messages, source, device, route, metrics, household traffic, quality state, recovery, and uncertainty."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/a-symptom-pattern-atlas-for-video-buffering/"
related_articles:
  - "/blog/short-repeating-pauses-or-one-long-stall-compare-the-pattern/"
  - "/blog/why-time-of-day-buffering-needs-a-timeline/"
  - "/blog/how-to-collect-buffering-evidence-for-support/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc2330"
  - "https://www.rfc-editor.org/rfc/rfc7312"
  - "https://www.w3.org/TR/media-source-2/"
---
# How to Build a Buffering Timeline

> **In short:** Use three clocks: local wall time with time zone, elapsed time since playback began, and title timecode. Add picture, audio, controls, messages, source version, device, route, network samples, household activity, quality state, recovery action, and uncertainty. Record before changing anything and repeat the same case once.

A timeline turns “it buffered in the evening” into events that can be aligned across player, network, household, and source boundaries.

## Synchronize time safely

Confirm device clocks use automatic time or record their offset. Include the time zone and daylight-saving state. Manual stopwatch timing is sufficient when labeled approximate; do not claim millisecond precision.

Avoid screenshots that expose notifications, account names, network identifiers, or viewing history.

## Define the playback clock

Choose the moment elapsed playback starts, such as the first advancing frame. Record startup separately. At every event, note the visible title timecode and whether the playhead advances.

If seeking occurs, record old and new positions rather than continuing one uninterrupted elapsed sequence.

## Split audio and picture

Record moving picture, frozen frame, black screen, audio advancing, audio looping, captions, controls, and synchronization separately. A single “stall” label loses important information.

[The pause-pattern guide](/blog/short-repeating-pauses-or-one-long-stall-compare-the-pattern/) helps capture cadence and duration.

## Add source and player context

Record authorised source, exact title version, quality mode, tracks, app and operating-system versions, device, output, and any visible message or code. Do not infer hidden buffer size or decoder state.

W3C Media Source Extensions offers buffered-range vocabulary for compatible web implementations, not a universal app diagnostic.

## Original evidence: three-clock timeline

| Wall time/zone | Elapsed time | Title timecode | Picture/audio/control | Quality/message | Route/metrics | Household/source context | Recovery |
|---|---|---|---|---|---|---|---|
| Start | 00:00 | Position | First frame | State | Baseline | Context | N/A |
| Before event | Value | Position | Behavior | State | Values | Context | N/A |
| Event | Value | Position | Behavior | Message | Values | Context | None/action |
| Resume | Value | Position | Behavior | State | Values | Context | Result |

Add an uncertainty column for manually observed or missing fields.

## Align network evidence

Record active wired or Wi-Fi path, node, throughput, delay variation, loss method, and route transition. RFC 2330 emphasizes defined performance metrics, while RFC 7312 discusses sampling frameworks.

Do not run a high-volume test during playback unless controlled competition is the research question.

## Align household activity

With permission, use categories such as upload, backup, call, update, or second video session. Record observed start and stop times. Do not monitor payloads or identify household members.

[The time-of-day guide](/blog/why-time-of-day-buffering-needs-a-timeline/) expands this timeline across several days.

## Capture recovery in order

Record whether playback resumes by waiting, seeking, changing version, reconnecting, restarting the app, changing device, or changing network. Perform one action at a time and write its exact time.

A recovery action changes state and can erase the original condition, so preserve evidence first.

## Repeat and compare

Replay from before the event with the same version, device, path, and time window. Then change one axis: title, device, link, or time. Keep both event and non-event runs.

Do not continue until the expected result appears; predefine a small trial count.

## Prepare a shareable version

Retain the full private log only as long as needed. Produce a redacted summary with device class, abstract path, time window, event, metric method, comparisons, recovery, and unknowns. [The support-evidence guide](/blog/how-to-collect-buffering-evidence-for-support/) supplies a redaction checklist.

Norva organises and plays compatible authorised sources. Current logs, playback states, and diagnostics must be verified from official Norva support material.

## Frequently asked questions

### Which clock matters most?

All three answer different questions: wall time reveals schedules, elapsed time reveals session patterns, and title timecode reveals media-position patterns.

### Should network tests run continuously?

Not by default. They can add traffic, expose data, and alter queues; use minimal, defined sampling.

### Can a screen recording replace the timeline?

It can support observations but may expose private data and still omit network or household context. Redact and document separately.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [RFC 2330: Framework for IP Performance Metrics](https://www.rfc-editor.org/rfc/rfc2330)
- [RFC 7312: Advanced Stream and Sampling Framework](https://www.rfc-editor.org/rfc/rfc7312)
- [W3C Media Source Extensions](https://www.w3.org/TR/media-source-2/)