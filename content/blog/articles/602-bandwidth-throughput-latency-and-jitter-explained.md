---
content_id: "NVB-602"
title: "Bandwidth, Throughput, Latency, and Jitter Explained"
seo_title: "Bandwidth vs Throughput vs Latency vs Jitter: Video Guide"
meta_description: "Understand bandwidth, throughput, latency and jitter with a worked video-network example. Learn why a speed-test score or universal jitter limit can mislead."
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
supporting_questions:
  - "What is acceptable jitter for video playback?"
  - "Why can video buffer after a fast speed-test result?"
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
updated_at: "2026-09-10T20:52:12Z"
last_fact_check: "2026-09-10"
estimated_reading_minutes: 6
excerpt: "Capacity, measured transfer rate, delay and delay variation answer different questions. Interpret a completed network comparison before blaming one number for buffering."
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
  type: "worked illustrative network comparison"
  summary: "A completed, fictional quiet-time and busy-time comparison distinguishes throughput medians, round-trip latency and tool-specific jitter without inventing a universal threshold."
  methodology: "The example fixes device, endpoint, test configuration and link, supplies individual throughput runs and defines units. Results are teaching values, not measurements of Norva or a provider."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/the-complete-guide-to-home-network-basics-for-video/"
related_articles:
  - "/blog/the-complete-guide-to-home-network-basics-for-video/"
  - "/blog/a-symptom-pattern-atlas-for-video-buffering/"
  - "/blog/the-complete-guide-to-understanding-video-quality/"
cta:
  label: "Match Your Playback Symptom to the Next Check"
  href: "https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc6349"
  - "https://www.rfc-editor.org/rfc/rfc7679"
  - "https://www.rfc-editor.org/rfc/rfc3393"
  - "https://www.rfc-editor.org/rfc/rfc7680"
---
# Bandwidth, Throughput, Latency, and Jitter Explained

> **In short:** Bandwidth is an available or nominal capacity concept; throughput is the useful rate measured in a specific test. Latency is delay, while jitter describes delay variation under a stated method. Packet loss is separate again. Video can be affected by one or several, so record the method and path before interpreting a number.

Every metric is a partial view. Two tests with the same unit can still measure different endpoints, protocols, directions, durations, routes, or traffic conditions.

## Bandwidth is not a delivered result

People often use bandwidth as shorthand for speed, but capacity labels do not say how much application data arrived during a particular interval. Shared links, protocol overhead, congestion, radio conditions, device limits, and the remote endpoint can reduce observed throughput.

A plan rate, Wi-Fi link rate, Ethernet label, and application throughput are therefore different values. Record which one a screen displays before comparing it with another.

## Throughput needs a test context

Throughput is a measured transfer rate. RFC 6349 describes a framework for TCP throughput testing and emphasizes test methodology. A result belongs with its endpoint, direction, protocol, duration, number of connections, device, route, and time.

[The home-network basics guide](/blog/the-complete-guide-to-home-network-basics-for-video/) maps the path between the device and source. A nearby test server does not reproduce every authorised source path, and a brief peak should not be presented as sustained application performance.

## Latency is elapsed delay

Latency describes how long data or a response takes to travel through a measured path. One-way delay needs clock synchronisation and an account of timing uncertainty under RFC 7679's method; many consumer tools instead report a round trip. Those results are not interchangeable.

Video startup, controls, authentication, and segment requests can feel responsive or delayed for different reasons. A high throughput result does not automatically mean low latency.

## Jitter is variation, not simply slowness

RFC 3393 defines packet delay variation metrics. In everyday tools, “jitter” may use a different calculation, direction, interval, or statistic. Read the tool's definition before comparing values.

A connection can have adequate average throughput yet irregular packet arrival, or stable delay with insufficient sustained throughput. A constant 80 ms round trip and one alternating between 20 and 140 ms can share an average while behaving differently. That illustration describes variation, not a jitter formula or an acceptable limit.

## Packet loss is another dimension

RFC 7680 defines a one-way packet loss metric with explicit methodology. Consumer results may instead infer loss from missing replies, and some devices can deprioritize diagnostic traffic. A reported zero does not prove every application packet arrived; a nonzero result needs recurrence and scope.

Keep missing packets separate from late packets in your notes. A playback pause is a visible symptom, not a packet-level diagnosis.

## Original evidence: metric dictionary

| Metric | Plain-language question | Required context | What it cannot prove alone |
|---|---|---|---|
| Bandwidth/capacity | What could this link carry under its definition? | Link, label, direction | Application delivery |
| Throughput | What useful rate was measured? | Endpoint, protocol, duration, route | Every source path |
| Latency | How much delay did the method observe? | One-way/round-trip, clocks, path | Sustained capacity |
| Jitter | How did delay vary? | Formula, sample, statistic | Average throughput |
| Loss | Which expected packets were absent? | Probe type, direction, interval | Exact playback cause |

Attach units to every value and preserve raw results where privacy permits.

### Worked example: a fast plan and an inconsistent evening

These are **fictional teaching results**, not a test of Norva or a source. A household has a plan labelled 100 Mbps. It tests the same laptop in the same Wi-Fi location against the same nearby endpoint, using identical download settings and three 30-second runs in each window.

| Observation | Quiet window | Busy window | Interpretation |
|---|---|---|---|
| Download throughput, three runs | 82, 80, 84 Mbps | 28, 14, 31 Mbps | Median falls from 82 to 28 Mbps; busy-window range is 14–31 Mbps |
| Tool-reported median round-trip delay, taken under the same load condition | 18 ms | 65 ms | This test path responds more slowly in the busy window |
| Tool's displayed jitter, same formula and sampling settings | 3 ms | 24 ms | Delay varies more under this tool's definition; this is not a pass/fail grade |
| Authorised video during the busy window | Not checked | Two pauses recorded | Pauses coincide with worse results, but the video endpoint was not measured |

The reasonable next step is a repeat at the symptom time, optionally changing only the local connection to Ethernet if supported. It is **not** to buy a faster plan immediately. Even the 14 Mbps sample cannot establish whether the video should play: the version's actual requirements, short dips, source path and buffering behaviour are unknown.

Keep Mbps (megabits per second) distinct from MB/s (megabytes per second): 8 Mbps equals 1 MB/s before accounting for the measurement's overhead definition. Milliseconds describe time, not data rate. These units cannot be compared as if a larger number always meant a better connection.

## Build a small measurement set

Use the affected device in its normal location. Record three spaced samples at a quiet time and three during the symptom window. Where safe and supported, repeat over one alternate local link without changing the endpoint or test settings.

Then compare medians, ranges, and recurrence rather than selecting the best number. Note simultaneous uploads, mesh changes, device power state, and weather only when directly observed; do not invent causal stories around coincidental events.

## Interpret combinations

Low sustained throughput can drain a playback buffer. Delay variation and loss can disrupt delivery even when a short average rate looks adequate. High latency may slow request-response sequences without necessarily limiting a long transfer. The application, transport behavior, buffering design, and source determine visible impact.

If playback continues but looks poor, use the [picture-quality comparison](/blog/the-complete-guide-to-understanding-video-quality/) instead of treating blur as proof of a slow network. Norva plays compatible authorised sources; it does not supply a catalogue or control your router, the source path or its encoding.

## Common interpretation errors

Do not compare bits with bytes, confuse link rate with throughput, label all delay variation “packet loss,” or treat a single server result as a guarantee. Avoid measuring only after changing router, device, and source together.

## Frequently asked questions

### Which metric matters most for video?

No single metric always dominates. The version's delivery pattern, path, device, and symptom determine which measurements are relevant.

### Can throughput exceed a plan label?

Labels, provisioning, test methods, units, and overhead definitions vary. Verify what each number represents before treating a difference as an error.

### Is jitter measured the same way by every tool?

No. Check the tool's formula, direction, probe type, sample period, and reported statistic.

### What is acceptable jitter for video streaming?

There is no universal millisecond cutoff that certifies video playback. Buffered on-demand video and interactive calls tolerate delay differently; tools also calculate jitter differently. Compare repeated results from the same method with the actual symptom. A limit published for one application or protocol should not become a blanket requirement for Norva.

### Why does video buffer after a good speed test?

The test may use a different server, route, transfer pattern or time window. It may miss short disruptions, and playback also depends on the source and device. Record whether the delay happens before the first frame or during playback before choosing the next test.

## Your next step

[Match your playback symptom to the next check](https://norva.tv/blog/a-symptom-pattern-atlas-for-video-buffering/). Bring the device, time window, test method and one repeatable symptom—not source credentials—to any support request.

## Sources

- [RFC 6349: TCP Throughput Testing](https://www.rfc-editor.org/rfc/rfc6349)
- [RFC 7679: One-Way Delay Metric](https://www.rfc-editor.org/rfc/rfc7679)
- [RFC 3393: Delay Variation Metric](https://www.rfc-editor.org/rfc/rfc3393)
- [RFC 7680: One-Way Packet Loss Metric](https://www.rfc-editor.org/rfc/rfc7680)
