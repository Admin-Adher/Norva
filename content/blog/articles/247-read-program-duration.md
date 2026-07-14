---
content_id: "NVB-247"
title: "How to Interpret Start Times and Program Duration"
seo_title: "Interpret Program Start Times and Duration"
meta_description: "Calculate program boundaries from published start and duration, preserve optional actual timing separately, and handle midnight, gaps, overlaps, and clock changes safely."
slug: "read-program-duration"
canonical_url: "https://norva.tv/blog/read-program-duration/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should start times and program duration be interpreted?"
supporting_questions:
  - "How is a scheduled end calculated?"
  - "How should published and actual timing remain distinct?"
audience:
  - "Viewers reading program guide boundaries"
  - "Norva users investigating timing mismatches"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A boundary worksheet turns start and duration into a qualified scheduled interval without mistaking precise arithmetic for confirmed airtime."
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
parent_pillar: "/blog/live-program-guide-literacy/"
related_articles:
  - "/blog/read-now-and-next-guide/"
  - "/blog/interpret-overlapping-listings/"
  - "/blog/understand-overnight-guide-dates/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://www.iana.org/time-zones"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "program boundary worksheet"
  summary: "The worksheet captures published and actual timing, source and display zones, calculated end, next boundary, gap or overlap, and confidence."
  methodology: "Readers normalize timestamps, add duration on the timeline, convert full instants to local display, compare adjacent events, and label timing as published or actual."
  asset_urls: []
---

# How to Interpret Start Times and Program Duration

> **In short:** Treat published start plus published duration as a scheduled interval. Calculate the end on the underlying timeline, then convert the full timestamps to the display zone. Keep optional actual start and duration separate. Precise start and end values describe guide data; they do not independently prove that a live program followed the schedule exactly.

Start and duration appear elementary, yet several mistakes hide inside them: forgetting the date, mixing time zones, treating duration as an end time, or combining an actual start with a published duration without saying so.

## Complete the program boundary worksheet

| Field | Value |
|---|---|
| Service identifier |  |
| Event identifier |  |
| Published start |  |
| Published duration |  |
| Calculated published end |  |
| Actual start, if supplied |  |
| Actual duration, if supplied |  |
| Source and display zones |  |
| Previous event end |  |
| Next event start |  |
| Gap or overlap |  |
| Confidence |  |

Retain original values alongside converted display values.

## Calculate the scheduled interval

Use:

**Published end = published start + published duration**

Represent the interval as **[start, end)**: the start is included and the end is the boundary at which the event no longer qualifies as current. This avoids counting two adjacent events as current at the same exact instant.

Example: a listing starts at 20:15 and lasts 45 minutes. Its calculated scheduled end is 21:00. This is a generic arithmetic example, not a claim about a real schedule.

## Keep duration distinct from clock time

A duration of 01:30 means ninety minutes, not 1:30 a.m. Preserve units and validate impossible values such as negative duration or an unexpected zero. Do not replace a missing duration with the gap to the next event unless you explicitly label that as an estimate.

## Separate published and actual timing

The DVB-I specification distinguishes published start and duration from optional actual start and actual duration. If actual timing is present, record a complete coherent pair when possible. Do not present:

- actual start + published duration as a verified actual end;
- published start + actual duration as the published interval;
- an interface progress bar as an actual-time measurement.

When only one actual field exists, state the limitation.

## Convert on the timeline, not by the clock face

Calculate or preserve the absolute event boundaries, then convert both to the target named zone. Around daylight-saving changes, local clock labels can repeat or skip. The IANA Time Zone Database provides date-dependent zone rules used by many systems.

If the end lands on another date, follow [the overnight date workflow](/blog/understand-overnight-guide-dates/). Do not truncate the event at midnight to keep it on one visual day.

## Compare adjacent events

Once boundaries are calculated:

- if next start equals current end, the schedule is contiguous;
- if next start is later, there is a published gap;
- if next start is earlier, the intervals overlap;
- if the next timestamp uses another zone or date basis, normalize it first.

Use [the overlapping-listings diagnostic](/blog/interpret-overlapping-listings/) rather than shortening one event by guesswork.

## Derive now-and-next cautiously

Compare the current guide clock with the interval only after service, date, and zone are known. [The now-and-next checksum](/blog/read-now-and-next-guide/) adds freshness and following-event checks.

A progress estimate can be computed as elapsed time divided by published duration, bounded between zero and one. Label it “scheduled progress.” It does not monitor the live signal.

## Validate unusual durations

An unusually long event may be a marathon, a generic block, an overnight holding entry, or a metadata error. An unusually short event may be an interstitial or a truncated listing. Compare title, genre, neighboring events, source update, and stable identifiers. Do not “correct” length based on what similar programs usually do.

Norva can display timing information from compatible sources a user is authorized to access. Schedule accuracy and the presence of actual timing depend on source data. Consult current support information for product-specific display behavior.

## Common mistakes and limitations

- Reading duration as a wall-clock time.
- Omitting the date near midnight.
- Applying one current offset to every event date.
- Mixing published and actual timing silently.
- Inferring missing duration from the next row.
- Treating scheduled progress as live monitoring.

## Frequently asked questions

### Is the next start always the current end?

No. Schedules can contain gaps, overlaps, or updates. Calculate each boundary independently.

### What if duration is missing?

Keep the end unknown unless another authoritative field supplies it. Do not fabricate a duration.

### Why can local duration look different across a clock change?

Elapsed time follows the timeline, while displayed wall-clock labels can repeat or skip during zone transitions.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [Norva: How It Works](https://norva.tv/#how-it-works)
