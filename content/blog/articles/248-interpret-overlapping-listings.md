---
content_id: "NVB-248"
title: "How to Read Overlapping Program Listings"
seo_title: "How to Interpret Overlapping Program Listings"
meta_description: "Diagnose overlapping guide events with a reconciliation ledger for service identity, normalized time, updates, duplicates, and published versus actual timing."
slug: "interpret-overlapping-listings"
canonical_url: "https://norva.tv/blog/interpret-overlapping-listings/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should overlapping program listings be interpreted?"
supporting_questions:
  - "Which checks distinguish valid parallel services from conflicting events?"
  - "How should updated and duplicate schedule records be reconciled?"
audience:
  - "Viewers troubleshooting guide events that occupy the same time"
  - "Norva users evaluating schedule consistency"
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
excerpt: "An interval-reconciliation ledger distinguishes expected parallel schedules from same-service conflicts that need updated or stronger source evidence."
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
  - "/blog/read-program-duration/"
  - "/blog/check-program-guide-freshness/"
  - "/blog/channel-vs-program-metadata/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "consideration"
sources:
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "schedule interval-reconciliation ledger"
  summary: "The ledger compares service, event identity, source revision, published and actual boundaries, zone, duplication, and confidence for every overlap."
  methodology: "Readers normalize intervals, confirm same-service scope, rank updates by explicit source evidence, preserve unresolved records, and verify the chosen result at adjacent boundaries."
  asset_urls: []
---

# How to Read Overlapping Program Listings

> **In short:** First confirm whether the events belong to the exact same service. Normalize both intervals to one time basis, preserve published and actual timing separately, then compare identifiers and source revisions. Overlaps across different services are normal; unresolved overlaps on one service are a schedule conflict, not permission to shorten or delete an event by intuition.

Two events appearing at the same time can describe ordinary parallel channels, a regional variant, a late schedule update, duplicate data, or inconsistent boundaries. The visual symptom is the same, but each cause requires a different response.

## Build the interval-reconciliation ledger

| Field | Event A | Event B |
|---|---|---|
| Service identifier |  |  |
| Event identifier |  |  |
| Source and revision time |  |  |
| Published start |  |  |
| Published end |  |  |
| Actual start/end, if supplied |  |  |
| Normalized zone |  |  |
| Title and episode |  |  |
| Duplicate relationship |  |  |
| Confidence |  |  |

Calculate each end independently with [the program-duration worksheet](/blog/read-program-duration/).

## Confirm scope before calling it an overlap

Events on different services can occupy the same interval without conflict. So can regional variants or time-shifted services. Compare stable service identifiers with [the channel-versus-program metadata method](/blog/channel-vs-program-metadata/), not logos alone.

Only call it a same-service overlap when both events are tied to the same verified service and their normalized time intervals intersect.

## Normalize time and date

Convert both full timestamps to one zone or timeline. Include dates. A listing at 23:30 UTC and another at 00:30 local time may represent adjacent boundaries after conversion rather than an overlap.

Use half-open intervals [start, end). Two events where A ends exactly when B starts are contiguous, not overlapping.

## Measure the intersection

The overlap begins at the later of the two starts and ends at the earlier of the two ends. If the computed start is before the computed end, the intervals intersect. Record the number of minutes without deciding which event is correct.

A one-minute overlap can be a boundary rounding issue; a full-event overlap can be duplicate or replacement data. Size is a clue, not proof.

## Check updates and timing types

The DVB-I specification distinguishes published timing from optional actual timing. Make sure both compared intervals use the same type. A late actual start can overlap a following published event without proving that the following program was canceled.

Look for an explicit update timestamp, replacement relationship, event identifier, or current source response. Prefer a clearly newer authoritative revision only when the source defines it as superseding the earlier record. Do not use file order or card position as revision evidence.

## Classify the overlap

- **Parallel services:** no conflict after service identity is separated.
- **Duplicate event:** identifiers and metadata indicate the same occurrence was ingested twice.
- **Schedule replacement:** a newer authoritative record supersedes an older event.
- **Published/actual divergence:** timing types differ because operations changed.
- **Time conversion error:** intervals align after correct normalization.
- **Unresolved same-service conflict:** evidence cannot select a record safely.

Preserve the unresolved class. It is more accurate than forcing one title into “Now.”

## Validate freshness and boundaries

Run [the guide freshness audit](/blog/check-program-guide-freshness/) to see whether one record belongs to an old coverage snapshot. Then inspect the previous and following events. A proposed resolution should not create a new unexplained gap or overlap.

## Communicate the problem

W3C notification guidance supports clear status and recovery. Report: “Two published events overlap by 12 minutes on Service 42; both came from the same refresh; current event unresolved.” Include zone and check time. Avoid “wrong show” until external evidence establishes which listing is incorrect.

Norva can display schedules from compatible authorized sources. Conflicting source records may remain visible until the feed is corrected or a verified update supersedes them. Product-specific handling should be checked in current support documentation.

## Common mistakes and limitations

- Calling parallel services an overlap conflict.
- Comparing local times without dates or zones.
- Mixing actual and published boundaries.
- Trusting visual card order as update order.
- Shortening the first event to make the grid tidy.
- Deleting unresolved evidence before a refresh.

## Frequently asked questions

### Which event should “Now” display during an unresolved overlap?

The interface may choose one, but the audit should label the result uncertain until stronger source evidence exists.

### Is a tiny overlap safe to round away?

Not automatically. Verify timestamp precision and source rules before normalization or rounding.

### Can both same-service events be valid?

They may represent layered or updated information, but a linear guide still needs explicit semantics. Preserve both until that relationship is known.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
