---
content_id: "NVB-243"
title: "How Time Zones Affect Program Guide Listings"
seo_title: "How Time Zones Affect Program Guide Listings"
meta_description: "Trace a guide listing from source timestamp to display zone with a UTC-local-date worksheet that handles daylight-saving changes, travel, and overnight events."
slug: "understand-guide-time-zones"
canonical_url: "https://norva.tv/blog/understand-guide-time-zones/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How do time zones affect program guide listings?"
supporting_questions:
  - "Why is a named time zone safer than a fixed offset?"
  - "How should overnight and daylight-saving boundaries be checked?"
audience:
  - "Viewers troubleshooting shifted program times"
  - "Norva users traveling or comparing guide displays"
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
excerpt: "A UTC-to-local worksheet reveals whether an apparent guide shift comes from source time, display zone, daylight-saving rules, or date rollover."
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
  - "/blog/understand-overnight-guide-dates/"
  - "/blog/read-now-and-next-guide/"
  - "/blog/check-program-guide-freshness/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://www.iana.org/time-zones"
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "guide timestamp conversion worksheet"
  summary: "The worksheet captures source timestamp, source zone, display zone, rule date, local conversion, event duration, and date rollover."
  methodology: "Readers preserve the original timestamp, convert with named time-zone rules for the event date, compare device and guide zones, and validate both start and end boundaries."
  asset_urls: []
---

# How Time Zones Affect Program Guide Listings

> **In short:** Preserve the source timestamp, identify both source and display zones, then convert using the rules that apply on the event date. Compare full dates as well as times. A fixed “plus one hour” rule can fail after travel, daylight-saving changes, or historical rule updates, and an overnight event may legitimately move to a different calendar date after conversion.

A listing that appears one hour early is not necessarily wrong at the source. The shift can occur during ingestion, conversion, device display, or comparison with another guide. A worksheet makes each step visible.

## Complete the UTC-local-date worksheet

| Field | Value |
|---|---|
| Original start timestamp |  |
| Original time standard or zone |  |
| Event date at source |  |
| Target display zone |  |
| Offset on that event date |  |
| Converted local start |  |
| Duration or source end |  |
| Converted local end |  |
| Date rollover? |  |
| Device zone and clock |  |

Do not overwrite the original timestamp. It is the recovery evidence if a later conversion looks wrong.

## Distinguish a zone from an offset

An offset such as UTC+01:00 describes one difference from Coordinated Universal Time. A named zone carries rules that can change by date, including daylight-saving transitions and political decisions. The IANA Time Zone Database records the history and rules used by many systems.

For a future or historical event, “Europe/Paris” and “UTC+01:00” are not interchangeable claims. The correct offset depends on the date covered by the zone rules.

## Convert the start and end independently

Convert the full start timestamp into the target zone. Then calculate or convert the end. If the source gives duration:

**Source end = source start + duration**

Convert that resulting timestamp, not merely the displayed hour. Around a clock change, the wall-clock difference between local start and local end may look unusual even though elapsed duration is correct.

The DVB-I specification uses schedule timestamps and supports published and optional actual timing concepts. Preserve which timing field you converted.

## Check the calendar date

An event starting late in one zone may appear after midnight in another. Always compare YYYY-MM-DD plus time. Use [the overnight guide date method](/blog/understand-overnight-guide-dates/) to distinguish source date, display date, and any interface “broadcast day” grouping.

Do not change the program’s identity because its local display date moved. Time conversion changes presentation, not the underlying event record.

## Diagnose a one-hour shift

Check in this order:

1. Is the source timestamp explicitly UTC, local time, or offset-bearing?
2. Which named zone does the guide display?
3. What rules applied on the event date?
4. Does the device clock match a trusted current time?
5. Did one layer apply daylight saving twice—or not at all?
6. Is the compared service a regional or time-shift variant?

Do not “fix” the row by manually subtracting one hour until the responsible layer is known.

## Compare devices after travel

A mobile device may update its zone automatically while a TV or browser retains a prior zone. Record each device’s current zone, whether guide settings override it, and the exact same event identifier. Then run [the now-and-next checksum](/blog/read-now-and-next-guide/) on both.

If both displays are internally consistent but use different zones, the times can differ without either schedule record being corrupt. The interface should label the zone or make it discoverable.

## Check freshness separately

A zone correction cannot repair an old schedule. If converted boundaries are sensible but “Now” remains stuck on an ended event, use [the program-guide freshness audit](/blog/check-program-guide-freshness/). Clock, zone, and freshness are independent failure modes.

Norva can present guide information from compatible sources a user is authorized to access. The source supplies event data; device and interface settings influence presentation. Current support documentation should be checked for exact zone controls in the build under review.

## Example without assuming a locale

Suppose a source event starts at 23:30 UTC and lasts 90 minutes. In a display zone whose applicable offset is +02:00, it appears at 01:30 on the following date and ends at 03:00. The arithmetic must use the offset valid for that date. This example demonstrates conversion only; it does not establish a real service schedule.

## Common mistakes and limitations

- Storing only the converted local time.
- Using today’s offset for another date.
- Comparing hours without dates.
- Applying a manual offset twice.
- Treating local date rollover as a new event.
- Trying to solve stale data with time-zone changes.

## Frequently asked questions

### Why do two guides differ by exactly one hour?

They may use different zones or daylight-saving rules, or one may have converted incorrectly. Trace the source timestamp before deciding.

### Does changing device time alter source metadata?

It should not alter the source event record, but it can change which event the interface calculates as current.

### Should UTC always be shown to viewers?

Not necessarily. Local display can be easier to use, provided the zone is clear and the original timestamp remains traceable.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [Norva Support](https://norva.tv/support)
