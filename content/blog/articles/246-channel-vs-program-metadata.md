---
content_id: "NVB-246"
title: "Channel Data and Program Data: Know the Difference"
seo_title: "Channel Data vs Program Data: Know the Difference"
meta_description: "Separate service identity from time-bound program metadata with a two-record matrix that prevents logos, titles, schedules, and availability from being mixed."
slug: "channel-vs-program-metadata"
canonical_url: "https://norva.tv/blog/channel-vs-program-metadata/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "explainer"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between channel data and program data?"
supporting_questions:
  - "Which fields belong to a service and which belong to a scheduled event?"
  - "How does mixing the two create guide errors?"
audience:
  - "Viewers interpreting live guide rows"
  - "Norva users diagnosing mismatched logos, titles, or schedules"
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
excerpt: "A two-record matrix keeps the service being scheduled separate from the program event placed on its timeline."
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
  - "/blog/interpret-blank-schedule-blocks/"
  - "/blog/recognize-recurring-programs/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://dvb.org/metadata/"
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "service-event metadata separation matrix"
  summary: "The matrix assigns identifiers, names, logos, variants, titles, timing, descriptions, and availability observations to their correct record."
  methodology: "Readers identify the service before the event, attach every field to one entity, test parent-child relationships, and report conflicts without copying values across records."
  asset_urls: []
---

# Channel Data and Program Data: Know the Difference

> **In short:** Channel—or service—data identifies where a schedule is published. Program data describes a time-bound event placed on that service. Keep their identifiers, names, images, availability, and update cycles separate. A correct channel logo cannot validate a show title, and a correct synopsis cannot prove that the row belongs to the intended regional service.

A guide row visually combines the service and its events, which makes the data look interchangeable. It is not. A service can exist without current event metadata, and an event record is meaningful only when attached to the right service and time interval.

## Use the two-record matrix

| Field | Service/channel record | Program event record |
|---|---|---|
| Stable identifier | Service identifier | Event or program identifier |
| Primary name | Channel/service name | Program title |
| Image | Logo or service artwork | Episode or program image |
| Variant | Region, language, time shift | Episode, version, repeat |
| Time | Service availability or schedule context | Start, duration, actual timing if supplied |
| Description | Service proposition | Synopsis or episode description |
| Relationship | Carries scheduled events | Belongs to one service interval |

When a field does not clearly fit either record, mark it unresolved instead of assigning it by appearance.

## Identify the service record

Service data can include a name, logo, identifier, region, language, access method, and schedule associations. It answers “which service is this?” It does not answer “what is airing now?”

Two services can share branding while differing by region or delay. Confirm the exact variant before comparing schedules. DVB metadata work explicitly covers service and program information, supporting this separation.

## Identify the event record

Program event data can include title, episode title, series relationship, synopsis, genre, parental information, image, start, and duration. It answers “what has been listed for this interval?”

An event title can recur on the same service. Use [the recurring-program fingerprint](/blog/recognize-recurring-programs/) to distinguish repeated slots, repeats, and distinct episodes rather than deduplicating by title.

## Understand the relationship

The service is the scheduled container; events occupy intervals on its timeline. One event record may be associated with a service at a specific time, while the underlying program can appear again elsewhere. Preserve both event identity and schedule occurrence when the source exposes them.

The DVB-I specification models service and schedule information with program events. That relationship is why a guide should not copy a service logo into the program-image field or turn a show title into a channel name.

## Diagnose common mismatches

### Right logo, wrong title

The service record may be correct while the event schedule is stale or mapped from another variant. Run [the now-and-next checksum](/blog/read-now-and-next-guide/).

### Right title, wrong logo

The event could be valid while the service mapping or visual asset is wrong. Compare stable service identifiers, not colors or branding alone.

### Blank title, playable service

Playback and guide metadata are separate. Use [the blank-schedule evidence ladder](/blog/interpret-blank-schedule-blocks/) and report that the service is playable while event information is unavailable.

### Description from another episode

Title-level matching may have attached descriptive metadata to the wrong event. Compare episode identifiers, season, number, duration, and source timestamps.

## Keep update cycles separate

Service names and logos may change less often than event schedules. Cache them independently when the system design allows, and report which record is stale. “Guide stale” is too broad when only one logo is outdated or one event interval is missing.

## Apply an entity-first debug note

Write every issue in this form:

**Entity → field → observed value → expected evidence → time checked**

For example: “Service 42 → logo → old brand asset → current service identity verified elsewhere → 2026-07-14 20:00 Europe/Paris.” This structure prevents a fix to the event title from being proposed for a service-logo problem.

Norva can organize and display live information from compatible sources a user is authorized to access. Source feeds determine which service and event fields are supplied and how complete they are; current product behavior should be checked in support material.

## Common mistakes and limitations

- Using a logo as proof of current programming.
- Comparing schedules across service variants without identifiers.
- Treating a playable service as proof of complete guide data.
- Deduplicating events by title alone.
- Applying one refresh timestamp to every record layer.
- Reporting a program error as a channel error.

## Frequently asked questions

### Is a channel the same as a service?

Interfaces often use the words similarly, but technical models may distinguish delivery and service concepts. Use the exact source vocabulary and preserve its identifier.

### Can one program appear on several services?

Yes. Keep each scheduled occurrence attached to its service and interval.

### Which record owns the progress bar?

The UI calculates it from the current event’s schedule and the guide clock; it is not a stable service property.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [DVB Metadata](https://dvb.org/metadata/)
- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [Norva Features](https://norva.tv/#features)
