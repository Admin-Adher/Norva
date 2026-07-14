---
content_id: "NVB-637"
title: "Run a Controlled Network Comparison Without Changing Everything"
seo_title: "Run a Controlled Network Buffering Comparison"
meta_description: "Compare one network layer at a time by fixing title, version, device, location, endpoint, method, household activity, and time before changing link, node, or route."
slug: "run-a-controlled-network-comparison-without-changing-everything"
canonical_url: "https://norva.tv/blog/run-a-controlled-network-comparison-without-changing-everything/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "controlled-network-protocol"
topic_cluster: "Buffering Diagnostics"
search_intent: "controlled network buffering comparison"
funnel_stage: "retention"
primary_question: "How can one network layer be compared without changing everything?"
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
excerpt: "Write one question, fix the authorised title version, device, location, app state, time window, household activity, endpoint, and measurement method, then change one network layer: wired versus Wi-Fi, access point, band, endpoint, or time. Repeat in reversed order, restore baseline, and report differences and unknowns."
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
  type: "single-variable network comparison sheet"
  summary: "A sheet pre-registers question, fixed title and device context, baseline path, one network variable, metric method, playback events, trial order, stopping rule, restoration, and limitations."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/a-symptom-pattern-atlas-for-video-buffering/"
related_articles:
  - "/blog/how-to-record-a-home-network-baseline/"
  - "/blog/wired-or-wi-fi-choose-by-the-viewing-environment/"
  - "/blog/how-to-build-a-buffering-timeline/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc2330"
  - "https://www.rfc-editor.org/rfc/rfc6349"
  - "https://www.rfc-editor.org/rfc/rfc7312"
---
# Run a Controlled Network Comparison Without Changing Everything

> **In short:** Write one question, fix the authorised title version, device, location, app state, time window, household activity, endpoint, and measurement method, then change one network layer: wired versus Wi-Fi, access point, band, endpoint, or time. Repeat in reversed order, restore baseline, and report differences and unknowns.

Changing router, DNS, app, device, and source together may make playback recover, but it cannot identify which change mattered.

## Pre-register the question

Use a narrow question such as “Does the event follow the Wi-Fi link?” or “Does it affect more than one external endpoint?” Define the visible outcome and a small trial count before testing.

Do not rewrite the question after seeing the first result; label a new idea as a separate exploratory test.

## Establish a documented baseline

[Record the home-network baseline](/blog/how-to-record-a-home-network-baseline/) with device, location, interface, node, endpoint, protocol, direction, duration, metric ranges, title version, tracks, and exact buffering event.

Preserve every valid run, including failures and unusually good results.

## Select one reversible variable

Useful choices include wired versus Wi-Fi, one supported band, one mesh node through normal placement, another reputable endpoint, or another time window. Avoid factory reset, security changes, unofficial firmware, and uncontrolled traffic generation.

[The wired-versus-Wi-Fi guide](/blog/wired-or-wi-fi-choose-by-the-viewing-environment/) covers installation and route limits.

## Original evidence: comparison sheet

| Field | Baseline A | Comparison B | Restored A |
|---|---|---|---|
| Pre-registered question | Same | Same | Same |
| Fixed title/device/context | Values | Same | Same |
| One changed network layer | Baseline | Exact change | Restored |
| Metric method/range | Values | Values | Values |
| Playback events | Results | Results | Results |
| Trial order/stopping | A first | B | A repeat |
| Unknowns/collateral effects | Notes | Notes | Notes |

Remove addresses, source URLs, credentials, and household identifiers before sharing.

## Keep measurement method fixed

RFC 2330 provides a performance-metric framework; RFC 6349 describes TCP throughput testing; RFC 7312 covers sampling. Use the same endpoint, protocol, direction, duration, connection count, and tool version.

If the changed link makes the tool unavailable, state the method difference rather than comparing unlike numbers.

## Control the time window

Run A, then B, then B, then A within a practical stable window. Reverse order on another day. Record household uploads, calls, updates, and source status. Stop if tests affect critical uses or metered limits.

Do not run capacity tests simultaneously with playback unless load competition is the exact question.

## Keep the media case fixed

Use the same authorised version, quality mode, tracks, starting position, and recovery policy. Source delivery can still change, so include another title as a later control rather than switching mid-trial.

[Build a buffering timeline](/blog/how-to-build-a-buffering-timeline/) for each run.

## Interpret only the changed layer

If the event follows Wi-Fi across A-B-B-A while wired remains stable, the local radio path gains relevance. Do not conclude that the router is defective; placement, client radio, node, interference, or configuration may be involved.

If both paths fail, move to a new question about a shared router, provider, source, or device layer.

Record inconclusive outcomes explicitly. A difference that appears once, vanishes after restoration, or changes with trial order needs another matched session rather than a stronger claim. If a hidden variable such as mesh node, source version, or household load changed, add it to the sheet and narrow the next comparison.

## Restore and verify

Return every documented setting, route, output, and household schedule. Confirm critical devices reconnect and security remains enabled. Record any failure to restore as part of the result.

Norva organises and plays compatible authorised sources. It cannot control network variables or source delivery, and current diagnostics need official verification.

## Frequently asked questions

### How many variables may change in one comparison?

Aim for one. When hidden changes occur, document them and weaken the conclusion.

### Is A-B enough?

A-B-B-A or repeated reversed order better exposes time drift and restoration, within safe practical limits.

### Can a comparison prove causation?

It can strengthen or weaken a boundary hypothesis, but home tests often leave uncontrolled variables and should report limits.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [RFC 2330: Framework for IP Performance Metrics](https://www.rfc-editor.org/rfc/rfc2330)
- [RFC 6349: TCP Throughput Testing](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7312: Advanced Stream and Sampling Framework](https://www.rfc-editor.org/rfc/rfc7312)