---
content_id: "NVB-260"
title: "A Live Program Guide Literacy Checklist"
seo_title: "A Live Program Guide Literacy Checklist"
meta_description: "Use a guide-reading checklist for service and event identity, timing, zones, freshness, categories, search, access, shared plans, late changes, and support evidence."
slug: "live-guide-literacy-checklist"
canonical_url: "https://norva.tv/blog/live-guide-literacy-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "checklist"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What checklist supports accurate live program guide reading?"
supporting_questions:
  - "Which checks are critical before relying on a guide event?"
  - "How should uncertainty and support evidence be handled?"
audience:
  - "Viewers who want a repeatable guide-reading method"
  - "Norva users auditing live guide behavior"
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
estimated_reading_minutes: 8
excerpt: "A live-guide release checklist turns service, event, time, freshness, discovery, access, planning, and support evidence into explicit pass conditions."
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
  - "/blog/live-program-guide-literacy/"
  - "/blog/check-program-guide-freshness/"
  - "/blog/document-guide-data-problem/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://www.iana.org/time-zones"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "live-guide literacy release checklist"
  summary: "The checklist covers service, event, timing, time zone, now-and-next, freshness, gaps, overlaps, discovery, access, shared plans, revisions, accessibility, and escalation."
  methodology: "Readers mark each critical gate pass, fail, or unknown with dated evidence and stop before action whenever identity, time, freshness, or authorization remains unresolved."
  asset_urls: []
---

# A Live Program Guide Literacy Checklist

> **In short:** Verify the service, event, published interval, full date, time zone, current clock, and source freshness before trusting a guide conclusion. Keep access separate from metadata. Mark every gate pass, fail, or unknown with dated evidence, and escalate only the narrowest reproducible problem without sharing credentials.

This checklist is a decision tool, not a promise that every source supplies complete data. Critical unknowns should block a confident “current program” or “accessible now” conclusion.

## Set up the guide review

| Gate | Status | Evidence | Action |
|---|---|---|---|
| Service identity | Pass / fail / unknown |  |  |
| Event identity |  |  |  |
| Timing and zone |  |  |  |
| Freshness |  |  |  |
| Discovery controls |  |  |  |
| Access separation |  |  |  |
| Late-change handling |  |  |  |
| Support evidence |  |  |  |

Record device, app or browser version, source context, date, and zone.

## Gate 1: service identity

- [ ] Service name and stable identifier agree.
- [ ] Region, language, and time-shift variant are known.
- [ ] Logo is treated as supporting, not decisive, evidence.
- [ ] Event metadata is not stored as service data.

Start with [the complete live-guide reading model](/blog/live-program-guide-literacy/) when the layers are unfamiliar.

## Gate 2: event identity

- [ ] Event identifier and service relationship are preserved.
- [ ] Program, series, episode, and schedule occurrence remain distinct.
- [ ] Repeats and recurring slots are not deduplicated by title alone.
- [ ] Missing episode fields remain unknown.
- [ ] Description and category conflicts are documented separately.

## Gate 3: timing and zone

- [ ] Published start and duration form a coherent interval.
- [ ] Optional actual timing is labelled separately.
- [ ] Full dates accompany times.
- [ ] Named-zone rules apply to the event date.
- [ ] Overnight boundaries preserve one event identity.
- [ ] Gaps and overlaps are not hidden by guesswork.

The DVB-I specification’s separation of published and actual timing is useful here. The IANA Time Zone Database is the authoritative reference for named-zone data releases.

## Gate 4: now-and-next and freshness

- [ ] The current event interval contains the guide clock.
- [ ] Next is the earliest valid following event on the same service.
- [ ] Retrieval time and coverage horizon are known.
- [ ] A recent boundary transitioned correctly.
- [ ] One control service or device was checked when needed.

Run [the freshness audit](/blog/check-program-guide-freshness/) before treating a plausible recurring title as current evidence.

## Gate 5: search and categories

- [ ] Search intent identifies service, program, episode, person, or time slot.
- [ ] One constraint changes at a time.
- [ ] Active filters and current/upcoming horizon are visible.
- [ ] Category combination logic is known.
- [ ] Uncategorized events remain reachable.
- [ ] Zero results are qualified by source scope and coverage.

## Gate 6: access separation

- [ ] Listing visibility is not treated as authorization.
- [ ] User owns or is authorized to use the connected source.
- [ ] Current source availability is checked separately.
- [ ] Device readiness and playback outcome are recorded.
- [ ] Credentials and private source details stay out of evidence.

Norva organizes and plays media from compatible sources users own or are authorized to access; it does not provide a supplied catalogue.

## Gate 7: planning and late changes

- [ ] Shared plans identify one exact occurrence.
- [ ] Participant zones and acceptable start/end windows are agreed.
- [ ] A fallback and final-check owner exist.
- [ ] Original and revised schedules are preserved.
- [ ] New revisions outrank old data only with explicit evidence.

## Gate 8: interaction and escalation

- [ ] Current focus and selected state remain distinguishable.
- [ ] TV, keyboard, and touch paths expose essential context.
- [ ] Status messages say what changed and how to recover.
- [ ] A report contains safe identifiers, timestamps, zone, reproduction, expected, and actual results.
- [ ] Screenshots are cropped and redacted.

Use [the support documentation bundle](/blog/document-guide-data-problem/) for unresolved failures.

## Decide whether the guide reading passes

Service identity, event identity, time basis, freshness, and authorization are critical for an immediate action. A failed or unknown critical gate blocks a confident conclusion. Category completeness may be non-critical for playback but critical for discovery claims.

## Common mistakes and limitations

- Passing a gate without evidence.
- Treating guide precision as on-air monitoring.
- Mixing local time and source time.
- Assuming listing equals access.
- Resetting before preserving the symptom.
- Escalating secrets or unrelated history.

## Frequently asked questions

### Must every gate pass before browsing?

No. Match rigor to the decision. Immediate playback and support claims need more evidence than casual exploration.

### Can the checklist be automated?

Some interval and identifier checks can, but authorization, household intent, and ambiguous source conflicts still need human review.

### What does unknown mean?

The available evidence cannot support pass or fail. Record the next safe check rather than guessing.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [Norva Support](https://norva.tv/support)
