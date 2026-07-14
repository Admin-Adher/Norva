---
content_id: "NVB-250"
title: "How to Recognize Recurring Programs in a Guide"
seo_title: "Recognize Recurring Programs in a Guide"
meta_description: "Recognize recurring guide events with a fingerprint that combines service, identifiers, title, episode metadata, scheduled slot, repeat evidence, and source freshness."
slug: "recognize-recurring-programs"
canonical_url: "https://norva.tv/blog/recognize-recurring-programs/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can recurring programs be recognized in a guide?"
supporting_questions:
  - "Which fields distinguish a recurring slot from a repeat or duplicate?"
  - "How much schedule evidence is needed before claiming a pattern?"
audience:
  - "Viewers interpreting repeated guide titles"
  - "Norva users organizing recurring live programs"
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
excerpt: "A recurring-program fingerprint distinguishes a repeating schedule pattern from the same episode airing again or a duplicate event record."
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
  - "/blog/channel-vs-program-metadata/"
  - "/blog/check-program-guide-freshness/"
  - "/blog/read-program-duration/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://dvb.org/metadata/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "recurring-program fingerprint"
  summary: "The fingerprint combines service, program and event identifiers, normalized title, episode identity, schedule slot, duration, repeat evidence, and freshness."
  methodology: "Readers collect several occurrences, compare stable and changing fields, classify series recurrence separately from episode repeats and duplicate records, and state pattern confidence."
  asset_urls: []
---

# How to Recognize Recurring Programs in a Guide

> **In short:** Collect several occurrences and compare service, program identifiers, event identifiers, title, episode metadata, scheduled slot, duration, repeat evidence, and freshness. A recurring program is a pattern across distinct schedule events. The same title alone cannot distinguish a new episode, a rerun, a generic block, or duplicate data.

Guide repetition has several meanings. A daily news program may create a new event each day; a drama episode may repeat later; a title may be a generic holding label; or one record may have been ingested twice. A fingerprint separates the stable program concept from each scheduled occurrence.

## Build the recurring-program fingerprint

| Field | Occurrence 1 | Occurrence 2 | Occurrence 3 |
|---|---|---|---|
| Service identifier |  |  |  |
| Program or series identifier |  |  |  |
| Event identifier |  |  |  |
| Raw title |  |  |  |
| Normalized title |  |  |  |
| Episode or edition |  |  |  |
| Start date, time, zone |  |  |  |
| Duration |  |  |  |
| Repeat flag or evidence |  |  |  |
| Source refresh |  |  |  |

Use at least two occurrences to suggest a pattern and more when the cadence claim matters.

## Confirm service scope

A title appearing at the same time on two different services is not necessarily a recurrence on either one. Establish the exact service with [the channel-versus-program metadata workflow](/blog/channel-vs-program-metadata/). Regional and time-shift variants should remain distinct unless the analysis explicitly compares them.

## Separate three identities

1. **Program concept:** the series, show, or named block.
2. **Episode or edition:** the particular content instance, when supplied.
3. **Schedule event:** one occurrence on a service at a specific interval.

DCMI terms distinguish titles, identifiers, dates, relations, and temporal information. Keeping these fields separate prevents a recurring title from being treated as one endlessly extended event.

## Normalize titles cautiously

Preserve the raw title before making a comparison form. You may standardize whitespace or clearly equivalent punctuation for analysis, but do not remove episode numbers, edition dates, regional labels, or qualifiers that distinguish occurrences.

“Morning Update,” “Morning Update — Weekend,” and “Morning Update: 14 July” may belong to a family while representing different editions. State the level at which recurrence is claimed.

## Compare the schedule pattern

Normalize all starts to one named zone, then test:

- same local time on consecutive weekdays;
- same weekday and time each week;
- repeated intervals within one day;
- irregular recurrence tied to events;
- time shifts around daylight-saving changes.

Record exceptions. A pattern is a description of observed or authoritative schedule data, not a guarantee of future occurrence.

Use [the program-duration worksheet](/blog/read-program-duration/) so similar-looking slots are compared with full boundaries rather than start times alone.

## Distinguish new editions, repeats, and duplicates

### New edition

Program identity stays related, while event and episode or edition identity changes. Date, synopsis, or episode fields may provide evidence.

### Repeat or rerun

The same episode or edition appears in a new schedule event. Use explicit repeat metadata or matching stable content identity when available. Do not infer a rerun solely from title and duration.

### Duplicate record

Two records describe the same service occurrence and interval without a meaningful identity difference. Check event identifiers, revision state, and source behavior before deduplicating.

### Generic block

A broad title covers changing or unspecified content. Treat it as a schedule label unless finer-grained metadata exists.

## Check freshness before declaring recurrence

Old schedule data can make yesterday’s pattern appear to repeat today. Run [the guide freshness audit](/blog/check-program-guide-freshness/) and record the coverage horizon. A current recurring pattern needs current occurrences.

## State confidence and scope

- **High:** stable program identity plus several current events and explicit episode or repeat evidence.
- **Medium:** consistent service, title, and schedule pattern, but limited identity fields.
- **Low:** title similarity with incomplete timing or stale data.

Write “observed weekday recurrence on Service A across three current events” rather than “always airs weekdays.”

Norva can display and organize live program information from compatible authorized sources. Recurrence quality depends on supplied identifiers, schedule coverage, and update freshness. Recommendations or visual proximity are not recurrence evidence.

## Common mistakes and limitations

- Deduplicating by title alone.
- Mixing occurrences across service variants.
- Calling every repeated title a rerun.
- Ignoring episode or edition identifiers.
- Claiming a future cadence from one event.
- Finding patterns in stale schedule data.

## Frequently asked questions

### How many occurrences prove a recurring program?

No universal number does. Two suggest repetition; more current, well-identified events support a stronger cadence claim.

### Is the same duration evidence of a rerun?

It is supporting evidence only. Different editions often share a slot length.

### What if no episode metadata exists?

Claim recurrence only at the title or program level and keep repeat status unknown.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [DVB Metadata](https://dvb.org/metadata/)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva: How It Works](https://norva.tv/#how-it-works)
