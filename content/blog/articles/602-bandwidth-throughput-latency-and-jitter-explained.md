---
content_id: "NVB-602"
title: "Bandwidth, Throughput, Latency, and Jitter Explained"
seo_title: "Bandwidth, Throughput, Latency, and Jitter"
meta_description: "Learn how bandwidth, measured throughput, latency, jitter, and packet loss differ, what each network metric can show, and why context prevents false conclusions."
slug: "bandwidth-throughput-latency-and-jitter-explained"
canonical_url: "https://norva.tv/blog/bandwidth-throughput-latency-and-jitter-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "network-literacy-guide"
topic_cluster: "Home Network Video Basics"
search_intent: "video network metric vocabulary"
funnel_stage: "retention"
primary_question: "How do bandwidth, throughput, latency, and jitter differ?"
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
estimated_reading_minutes: 5
excerpt: "Bandwidth is an available or nominal capacity concept; throughput is the useful rate measured in a specific test. Latency is delay, while jitter describes delay variation under a stated method. Packet loss is separate again. Video can be affected by one or several, so record the method and path before interpreting a number."
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
  type: "network metric evidence dictionary"
  summary: "A dictionary binds each result to definition, units, method, endpoint, direction, duration, route, time, and diagnostic limit."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/the-complete-guide-to-home-network-basics-for-video/"
related_articles:
  - "/blog/how-to-read-a-speed-test-without-overinterpreting-it/"
  - "/blog/what-packet-loss-can-look-like-during-video/"
  - "/blog/how-jitter-differs-from-a-slow-connection/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc6349"
  - "https://www.rfc-editor.org/rfc/rfc2679"
  - "https://www.rfc-editor.org/rfc/rfc3393"
  - "https://www.rfc-editor.org/rfc/rfc2680"
---
# Bandwidth, Throughput, Latency, and Jitter Explained

> **In short:** Bandwidth is an available or nominal capacity concept; throughput is the useful rate measured in a specific test. Latency is delay, while jitter describes delay variation under a stated method. Packet loss is separate again. Video can be affected by one or several, so record the method and path before interpreting a number.

Every metric is a partial view. Two tests with the same unit can still measure different endpoints, protocols, directions, durations, routes, or traffic conditions.

## Bandwidth is not a delivered result

People often use bandwidth as shorthand for speed, but capacity labels do not say how much application data arrived during a particular interval. Shared links, protocol overhead, congestion, radio conditions, device limits, and the remote endpoint can reduce observed throughput.

A plan rate, Wi-Fi link rate, Ethernet label, and application throughput are therefore different values. Record which one a screen displays before comparing it with another.

## Throughput needs a test context

Throughput is a measured transfer rate. RFC 6349 describes a framework for TCP throughput testing and emphasizes test methodology. A result belongs with its endpoint, direction, protocol, duration, number of connections, device, route, and time.

[The speed-test interpretation guide](/blog/how-to-read-a-speed-test-without-overinterpreting-it/) explains why a nearby test server does not reproduce every authorised source path. A brief peak also should not be presented as sustained application performance.

## Latency is elapsed delay

Latency describes how long data or a response takes to travel through a measured path. One-way delay requires synchronized clocks under RFC 2679's method; many consumer tools instead report a round trip. Those results are not interchangeable.

Video startup, controls, authentication, and segment requests can feel responsive or delayed for different reasons. A high throughput result does not automatically mean low latency.

## Jitter is variation, not simply slowness

RFC 3393 defines packet delay variation metrics. In everyday tools, “jitter” may use a different calculation, direction, interval, or statistic. Read the tool's definition before comparing values.

A connection can have adequate average throughput yet irregular packet arrival, or stable delay with insufficient sustained throughput. [The jitter comparison guide](/blog/how-jitter-differs-from-a-slow-connection/) shows how to separate these patterns with a timeline.

## Packet loss is another dimension

RFC 2680 defines a one-way packet loss metric with explicit methodology. Consumer results may instead infer loss from missing replies, and some devices can deprioritize diagnostic traffic. A reported zero does not prove every application packet arrived; a nonzero result needs recurrence and scope.

[The packet-loss symptom guide](/blog/what-packet-loss-can-look-like-during-video/) avoids equating one playback pause with proven loss.

## Original evidence: metric dictionary

| Metric | Plain-language question | Required context | What it cannot prove alone |
|---|---|---|---|
| Bandwidth/capacity | What could this link carry under its definition? | Link, label, direction | Application delivery |
| Throughput | What useful rate was measured? | Endpoint, protocol, duration, route | Every source path |
| Latency | How much delay did the method observe? | One-way/round-trip, clocks, path | Sustained capacity |
| Jitter | How did delay vary? | Formula, sample, statistic | Average throughput |
| Loss | Which expected packets were absent? | Probe type, direction, interval | Exact playback cause |

Attach units to every value and preserve raw results where privacy permits.

## Build a small measurement set

Use the affected device in its normal location. Record three spaced samples at a quiet time and three during the symptom window. Where safe and supported, repeat over one alternate local link without changing the endpoint or test settings.

Then compare medians, ranges, and recurrence rather than selecting the best number. Note simultaneous uploads, mesh changes, device power state, and weather only when directly observed; do not invent causal stories around coincidental events.

## Interpret combinations

Low sustained throughput can drain a playback buffer. Delay variation and loss can disrupt delivery even when a short average rate looks adequate. High latency may slow request-response sequences without necessarily limiting a long transfer. The application, transport behavior, buffering design, and source determine visible impact.

[The home-network basics guide](/blog/the-complete-guide-to-home-network-basics-for-video/) places these measurements within the full path. Norva plays compatible authorised sources; it does not control the household router, provider path, or source encoding. Any current diagnostics must be verified in official Norva information.

## Common interpretation errors

Do not compare bits with bytes, confuse link rate with throughput, label all delay variation “packet loss,” or treat a single server result as a guarantee. Avoid measuring only after changing router, device, and source together.

## Frequently asked questions

### Which metric matters most for video?

No single metric always dominates. The version's delivery pattern, path, device, and symptom determine which measurements are relevant.

### Can throughput exceed a plan label?

Labels, provisioning, test methods, units, and overhead definitions vary. Verify what each number represents before treating a difference as an error.

### Is jitter measured the same way by every tool?

No. Check the tool's formula, direction, probe type, sample period, and reported statistic.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [RFC 6349: TCP Throughput Testing](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 2679: One-Way Delay Metric](https://www.rfc-editor.org/rfc/rfc2679)
- [RFC 3393: Delay Variation Metric](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 2680: One-Way Packet Loss Metric](https://www.rfc-editor.org/rfc/rfc2680)