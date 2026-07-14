---
content_id: "NVB-249"
title: "Why Overnight Programs Can Appear Under a Different Date"
seo_title: "Why Overnight Programs Show Under Another Date"
meta_description: "Understand overnight guide dates by separating event start date, local display date, interface day grouping, end date, and time-zone conversion with a boundary card."
slug: "understand-overnight-guide-dates"
canonical_url: "https://norva.tv/blog/understand-overnight-guide-dates/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "explainer"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Why can overnight programs appear under a different guide date?"
supporting_questions:
  - "How do event date, display date, and interface day grouping differ?"
  - "How should an event crossing midnight be compared across zones?"
audience:
  - "Viewers troubleshooting late-night guide listings"
  - "Norva users comparing overnight schedules"
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
excerpt: "A date-boundary card explains how one event can keep its identity while its source date, local display date, and guide-day grouping differ."
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
  - "/blog/understand-guide-time-zones/"
  - "/blog/read-program-duration/"
  - "/blog/read-now-and-next-guide/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.iana.org/time-zones"
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "overnight event date-boundary card"
  summary: "The card separates source start, local start, local end, source date, display date, guide-day grouping, zone rules, and event identity."
  methodology: "Readers preserve the event instant, convert full boundaries with named-zone rules, identify the interface grouping convention, and compare event identifiers rather than date labels alone."
  asset_urls: []
---

# Why Overnight Programs Can Appear Under a Different Date

> **In short:** A program has event timestamps, while an interface also chooses how to group those timestamps into visible days. Time-zone conversion can move the local start to the previous or next calendar date, and an event that crosses midnight keeps one identity across two dates. Compare full timestamps and event identifiers before calling the listing misplaced.

Late-night schedules sit where three concepts collide: the source timestamp, the viewer’s local calendar, and the interface’s chosen guide-day boundary. The same event can be correctly described differently at each layer.

## Fill in the overnight date-boundary card

| Field | Value |
|---|---|
| Event identifier |  |
| Service identifier |  |
| Source start timestamp |  |
| Source time standard or zone |  |
| Local display zone |  |
| Local start date and time |  |
| Local end date and time |  |
| Interface guide-day label |  |
| Guide-day boundary rule, if known |  |
| Source refresh time |  |

This card prevents “Monday” from being treated as one universal property of the event.

## Separate four date concepts

### Source timestamp date

This is the date encoded with the original schedule timestamp or obtained in its declared time standard.

### Local display date

This is the date after conversion into the zone shown to the viewer. Follow [the guide time-zone worksheet](/blog/understand-guide-time-zones/) and use rules for the event date.

### End date

An event can begin before midnight and end after it. Calculate the end with [the program-duration method](/blog/read-program-duration/) rather than splitting the record at 00:00.

### Guide-day label

Some interfaces visually group early-morning hours with the preceding evening for continuity. Others use strict calendar days. This is a presentation convention and should be identified from the product, not assumed.

## Preserve event identity across midnight

Midnight does not create a new program event. Keep the same event identifier, service, and schedule occurrence while displaying its start and end dates accurately. If the grid renders the event across two day columns, that can be one visual representation of one interval.

Do not duplicate the event merely to fill both dates unless the source actually supplies distinct occurrences.

## Understand time-zone date rollover

Suppose an event starts at 23:30 in its source time basis. A target zone two hours ahead displays 01:30 on the next date; a zone several hours behind may display it earlier on the same or previous date. The event instant does not change.

The IANA Time Zone Database tracks named-zone changes, including daylight-saving rules. Convert with the rule applicable to the event date rather than a permanently remembered offset.

## Diagnose an apparent wrong-day listing

1. Confirm exact service and event identifiers.
2. Preserve the original source timestamp.
3. Identify source and display zones.
4. Convert full start and end instants.
5. Determine the interface’s day-grouping convention.
6. Compare source refresh timestamps.
7. Check another event well away from midnight as a control.

If only overnight entries shift, the day-grouping rule is a stronger candidate than a whole-guide clock failure. If every entry shifts by the same hour, investigate zone conversion.

## Derive “now” from the interval, not the day header

A program remains current while the guide clock is inside its event interval, even after the calendar date changes. Use [the now-and-next checksum](/blog/read-now-and-next-guide/) rather than assuming that every event under yesterday’s header has ended.

The DVB-I specification provides schedule timing concepts for program events. Presentation into days is a separate interface concern, so document both.

## Report the result precisely

Good: “Event 123 starts Tuesday 23:40 local, ends Wednesday 01:10, and is grouped under Tuesday by this guide view.”

Weak: “The Wednesday program is on the wrong day.”

Include zone, full timestamps, and whether the grouping behavior is verified or inferred.

Norva can display program information from compatible authorized sources. Exact guide-day grouping and time-zone controls should be verified against the current build and support documentation; source timing quality remains an external input.

## Common mistakes and limitations

- Comparing a day header without the event timestamp.
- Splitting one event into two at midnight.
- Using today’s offset for a different date.
- Treating local date rollover as source corruption.
- Assuming every interface begins a guide day at midnight.
- Ignoring stale source data after correct conversion.

## Frequently asked questions

### Which date should a program use?

State the convention: source date, local start date, or guide-day grouping. There is no useful answer without that context.

### Does an event ending tomorrow belong to tomorrow?

Its interval spans both dates. Many guides group it by start date, but the interface convention should be verified.

### Can travel move an event to another day?

Yes. Changing display zone can change the local calendar date while preserving the same event instant.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [Norva Features](https://norva.tv/#features)
