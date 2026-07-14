---
content_id: "NVB-251"
title: "How to Read a Guide During Last-Minute Schedule Changes"
seo_title: "Read a Guide During Last-Minute Schedule Changes"
meta_description: "Handle late schedule changes with a revision card that separates published and actual timing, source freshness, event identity, and the viewer's current clock."
slug: "handle-last-minute-schedule-changes"
canonical_url: "https://norva.tv/blog/handle-last-minute-schedule-changes/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should a guide be read during a last-minute schedule change?"
supporting_questions:
  - "How do published and actual timing differ?"
  - "Which revision evidence should outrank an older listing?"
audience:
  - "Viewers encountering late schedule changes"
  - "Norva users reconciling guide updates"
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
excerpt: "A schedule-revision card distinguishes a genuine late update from stale, overlapping, or differently timed guide records."
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
  - "/blog/check-program-guide-freshness/"
  - "/blog/read-now-and-next-guide/"
  - "/blog/interpret-overlapping-listings/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "last-minute schedule revision card"
  summary: "The card captures service and event identity, published and actual timing, revision evidence, source refresh, current clock, and unresolved conflicts."
  methodology: "Readers freeze the observation, normalize timestamps, rank explicit revisions, preserve superseded records, and recalculate now-and-next only after freshness is established."
  asset_urls: []
---

# How to Read a Guide During Last-Minute Schedule Changes

> **In short:** Preserve the old listing, identify the exact service and event, and look for a newer explicit source revision or actual-timing field. Check the current clock, zone, and refresh state before recalculating “Now” and “Next.” A familiar title, social comment, or changed card order is not enough to prove that one event superseded another.

Late changes can follow breaking news, overruns, cancellations, or operational decisions. A guide may receive the update immediately, later, or not at all. The goal is to report what the schedule data currently supports without presenting a published plan as monitored reality.

## Fill in the schedule-revision card

| Field | Before | Current |
|---|---|---|
| Service identifier |  |  |
| Event identifier |  |  |
| Published start and duration |  |  |
| Actual timing, if supplied |  |  |
| Source revision timestamp |  |  |
| Client retrieval timestamp |  |  |
| Display zone and clock |  |  |
| Current/next calculation |  |  |
| Confidence |  |  |

Keep the “before” column. It explains why two devices or viewers may temporarily disagree.

## Establish whether an update exists

An update is supported when the source exposes a newer revision, replacement relationship, changed event identity, or actual timing that clearly applies to the same service occurrence. The DVB-I specification distinguishes published start and duration from optional actual start and duration, which provides a useful model for keeping planned and operational timing separate.

Do not infer a replacement merely because a card moved or a title resembles what appears elsewhere. If two records remain active over the same interval, use [the overlapping-listings diagnostic](/blog/interpret-overlapping-listings/).

## Normalize the clocks

Record the current time, full date, and display zone. Convert both old and new event boundaries to the same basis. A one-hour difference can come from time-zone conversion rather than a late programming decision.

Then check the client retrieval time. A correct new source record cannot change a device that has not fetched it. Run [the program-guide freshness audit](/blog/check-program-guide-freshness/) before blaming event metadata.

## Recalculate now-and-next

Once the preferred current revision is defensible:

1. calculate the active interval from coherent timing fields;
2. compare it with the guide clock;
3. locate the first valid following event on the same service;
4. preserve any gap or overlap;
5. label the result published or actual;
6. state the check time.

Use [the now-and-next checksum](/blog/read-now-and-next-guide/) rather than manually moving the “Now” badge.

## Communicate uncertainty

W3C notification guidance favors clear status and recovery. Useful messages include:

- “Schedule updated at 20:12; current event now ends at 20:35.”
- “New listing received, but two events still overlap by 10 minutes.”
- “No updated source record available; original published schedule remains displayed.”

Avoid “program definitely canceled” unless authoritative evidence supports that stronger claim.

## Compare devices without overwriting evidence

If a TV and mobile device disagree, capture both service identifiers, event identifiers, retrieval times, and zones. Refresh one device once and record the result. Repeated resets can erase the useful distinction between an old cache and a new source response.

Norva can display guide information from compatible sources a user is authorized to access. Source publishers control whether and when last-minute changes arrive. Product-specific refresh behavior should be checked against current support documentation.

## Close the incident

After the boundary passes, verify which record remains in the guide history and whether the next event is coherent. Mark the outcome:

- applied update;
- delayed client refresh;
- unresolved source conflict;
- no update supplied;
- time-zone or service-variant misunderstanding.

Preserve the card when reporting a recurring problem.

## Common mistakes and limitations

- Deleting the original listing before comparison.
- Mixing published and actual fields silently.
- Treating card order as revision order.
- Ignoring service variants and time zones.
- Repeatedly refreshing without timestamps.
- Claiming the guide monitors the live signal.

## Frequently asked questions

### Should actual timing always replace published timing?

Only when the source clearly supplies it for the relevant event. Keep both for traceability.

### What if no revision timestamp exists?

Use identifiers, retrieval times, and current source response, lower confidence, and avoid destructive reconciliation.

### Can a late change create a guide gap?

Yes. Preserve that gap until a source record fills or explains it.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
