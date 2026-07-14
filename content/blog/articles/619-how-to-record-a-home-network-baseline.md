---
content_id: "NVB-619"
title: "How to Record a Home Network Baseline"
seo_title: "How to Record a Home Network Video Baseline"
meta_description: "Create a privacy-safe baseline for video devices, wired and Wi-Fi paths, times, endpoints, throughput, delay, variation, loss, household activity, and normal playback."
slug: "how-to-record-a-home-network-baseline"
canonical_url: "https://norva.tv/blog/how-to-record-a-home-network-baseline/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "measurement-protocol"
topic_cluster: "Home Network Video Basics"
search_intent: "home network video baseline"
funnel_stage: "retention"
primary_question: "How can a useful home-network baseline for video be recorded?"
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
excerpt: "A baseline is a repeatable record of normal conditions, not one best speed result. Fix the device, viewing position, wired or Wi-Fi path, endpoint, protocol, direction, duration, sample count, and authorised playback excerpt. Collect several quiet and typical-use windows, preserve ranges and failures, and protect network identifiers."
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
  type: "repeatable home-network baseline sheet"
  summary: "A sheet fixes device, location, link, access point, endpoint, protocol, direction, duration, time windows, household activity, sample count, playback excerpt, privacy, and change log."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/the-complete-guide-to-home-network-basics-for-video/"
related_articles:
  - "/blog/map-the-network-path-from-player-to-source/"
  - "/blog/how-to-read-a-speed-test-without-overinterpreting-it/"
  - "/blog/a-home-network-video-checklist/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc2330"
  - "https://www.rfc-editor.org/rfc/rfc6349"
  - "https://www.rfc-editor.org/rfc/rfc7312"
---
# How to Record a Home Network Baseline

> **In short:** A baseline is a repeatable record of normal conditions, not one best speed result. Fix the device, viewing position, wired or Wi-Fi path, endpoint, protocol, direction, duration, sample count, and authorised playback excerpt. Collect several quiet and typical-use windows, preserve ranges and failures, and protect network identifiers.

Without a baseline, “slower than usual” often means “different from a number remembered without context.”

## Define the purpose

Choose what the baseline should support: investigate buffering, compare rooms, evaluate a mesh change, monitor an access link, or document normal playback. One sheet can contain several metrics, but each needs a defined method.

Do not build a permanent surveillance system around household activity. Collect the minimum evidence required and set a retention period.

## Fix the path

[Map the player-to-source path](/blog/map-the-network-path-from-player-to-source/). Record device, operating system, app version, active interface, cable or Wi-Fi band, access point or node, router, viewing location, and test endpoint.

Mark hidden external hops unknown. Never include credentials, tokens, network names, hardware addresses, or private source locations in a shared baseline.

## Fix the measurement method

For throughput, record server, protocol, direction, duration, and connection count. For delay, variation, and loss, record probe type, direction, interval, and statistic. RFC 2330 provides a framework for clearly defined performance metrics.

[The speed-test guide](/blog/how-to-read-a-speed-test-without-overinterpreting-it/) explains why tool version belongs in the record.

## Choose representative times

Include a quiet window, a normal household-use window, and the recurring symptom window if known. Sample on more than one day. Keep the time zone and clock source consistent.

Do not run repeated high-volume tests on a metered plan or during critical uses.

## Original evidence: baseline sheet

| Field | Fixed context | Sample values |
|---|---|---|
| Device/location/link/node | Description | Status each run |
| Endpoint/protocol/direction | Method | Results |
| Duration/sample count | Method | Timestamps |
| Throughput/delay/variation/loss | Definitions | Median/range/failures |
| Household activity | Privacy-safe categories | Observed |
| Playback excerpt | Authorised title/time range | Startup/events/recovery |
| Changes since prior baseline | Software/network/environment | Notes |

Preserve every valid sample; do not discard low values merely because they look unusual.

## Include playback observations

Choose a compatible authorised title and exact section. Record startup time using one defined start and end event, pauses, quality changes, error messages, and recovery. Source behavior can change, so the title is a reference context rather than a fixed calibration signal.

Norva plays compatible authorised sources but cannot certify their current delivery or encoding.

## Summarize range, not perfection

Report median, minimum, maximum, spread, failed runs, and context. RFC 7312 discusses measurement sampling considerations. A baseline should expose variability, not compress it into one “normal speed.”

When methods change, start a new series rather than silently mixing results.

## Update after known changes

Record router firmware, device updates, access-point movement, new mesh node, cable replacement, provider equipment change, and major household network additions. Take before-and-after samples when possible.

Do not factory-reset equipment merely to refresh a baseline. [The network checklist](/blog/a-home-network-video-checklist/) emphasizes reversible steps.

## Use the baseline diagnostically

When a symptom appears, repeat the smallest matching sample set. If only Wi-Fi changed, investigate radio conditions. If every external endpoint and device changed, inspect shared router or access boundaries. If metrics remain within the recorded range but one title fails, inspect source, version, or player layers.

The baseline narrows questions; it does not automatically assign cause.

## Store it safely

Use abstract device codes and coarse room labels. Restrict access, encrypt sensitive records where appropriate, and delete raw details when no longer needed. A support summary should include methods and ranges but omit household schedules and identifiers.

Current Norva telemetry or export capabilities must be verified through official documentation before publication.

## Frequently asked questions

### How many samples create a baseline?

No universal count fits every home. Use multiple samples across representative times and continue until the normal range is reasonably stable.

### Should the fastest sample define normal?

No. Preserve the distribution, failures, and context rather than selecting the peak.

### Must the same title always be used?

A consistent authorised reference helps comparison, but source delivery can change; include network-only measurements and version context too.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [RFC 2330: Framework for IP Performance Metrics](https://www.rfc-editor.org/rfc/rfc2330)
- [RFC 6349: TCP Throughput Testing](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7312: Advanced Stream and Sampling Framework](https://www.rfc-editor.org/rfc/rfc7312)