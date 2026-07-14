---
content_id: "NVB-254"
title: "Current or Upcoming? Choose the Right Guide View"
seo_title: "Current or Upcoming? Choose the Right Guide View"
meta_description: "Choose between current and upcoming guide views with a task-and-horizon matrix covering immediate playback, planning, service scope, time zones, and freshness."
slug: "compare-current-upcoming-programs"
canonical_url: "https://norva.tv/blog/compare-current-upcoming-programs/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "decision-guide"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Should someone use the current or upcoming guide view?"
supporting_questions:
  - "Which view supports immediate viewing versus planning?"
  - "How do freshness and time horizon affect the choice?"
audience:
  - "Viewers choosing between live and future guide lists"
  - "Norva users planning shared viewing"
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
excerpt: "A task-and-horizon matrix selects the guide view that answers the viewer's immediate question without hiding timing uncertainty."
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
  - "/blog/plan-shared-viewing-from-guide/"
  - "/blog/check-program-guide-freshness/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "consideration"
sources:
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://www.w3.org/WAI/tutorials/forms/labels/"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "guide task-and-horizon decision matrix"
  summary: "The matrix connects viewer task, earliest useful time, planning horizon, service scope, zone, freshness, and required event fields to a current or upcoming view."
  methodology: "Readers state the decision first, choose the narrowest useful horizon, verify clock and coverage, and preserve a route between current and upcoming context."
  asset_urls: []
---

# Current or Upcoming? Choose the Right Guide View

> **In short:** Use the current view to decide what listed event can be evaluated now; use upcoming when the decision concerns a later start. Define the time horizon, service scope, and zone first. Then verify freshness. Neither view proves media access, and “upcoming” should not include events whose scheduled intervals already contain the current guide clock.

The two views answer different questions. Problems arise when an interface treats one as a prettier version of the other or when a viewer expects a planning list to show the context needed for immediate playback.

## Use the task-and-horizon matrix

| Viewer task | Best starting view | Required context |
|---|---|---|
| Decide what is listed now | Current | Service, current interval, clock, freshness |
| See what starts next | Current or now-and-next | Following event and boundary |
| Plan later today | Upcoming | Full date/time, zone, service, duration |
| Coordinate a household | Upcoming | People, availability window, decision deadline |
| Investigate a late change | Both | Revision and published/actual timing |
| Search for a named episode | Upcoming plus search | Series, episode, date window |

Choose the smallest view that contains the decision evidence.

## Define current precisely

An event is scheduled current when its interval contains the guide clock. Confirm service and zone, then use [the now-and-next checksum](/blog/read-now-and-next-guide/). A “Live” badge may describe the service or editorial status; it should not replace interval arithmetic and source evidence.

The current view should prioritize readable title, service, start, end or duration, and uncertainty. A progress bar is secondary because it is derived from schedule timing.

## Define upcoming precisely

Upcoming events start after the current guide time within a stated horizon. The horizon might be the next two hours, the rest of the day, or the available schedule window. Show its boundary so “upcoming” is not interpreted as an unlimited search.

Sort by normalized start timestamp, not localized time text alone. Preserve events with the same start on different services.

## Switch without losing context

When moving from current to upcoming, retain:

- selected service or clearly announce a scope change;
- display zone;
- active categories and search only when intended;
- current time marker;
- focused event, if it still belongs in the destination view.

W3C label guidance supports controls whose names explain destination and state. “Upcoming — next 4 hours” is clearer than an unlabeled arrow.

## Use upcoming for shared plans

For household coordination, use [the shared-viewing plan workflow](/blog/plan-shared-viewing-from-guide/) rather than favoriting every possible event. Record the earliest start everyone can make, latest acceptable end, required service, and a recheck time.

An upcoming listing can change. The closer the event gets, the more valuable a fresh check becomes.

## Handle boundary transitions

At an event start, it should leave upcoming and enter current according to the same clock and schedule basis. If it remains in both, inspect overlap or stale state. If it appears in neither, inspect gaps and filters.

Run [the program-guide freshness audit](/blog/check-program-guide-freshness/) when a transition fails. Avoid duplicating the event to satisfy both views.

## Do not confuse listing with access

The view describes guide events. It does not establish that a user can play the service on a given device or account. Keep access, availability, and guide metadata separate.

Norva can present current and upcoming information from compatible sources a user is authorized to access, subject to product behavior and source coverage. Check current support material for exact view controls.

## Build a graceful empty state

“No current event metadata” and “No upcoming events within the next four hours” are different states. Include the active horizon, service scope, filters, refresh time, and a recovery action. Do not say “nothing is on.”

## Common mistakes and limitations

- Using upcoming for an immediate decision without current context.
- Hiding the planning horizon.
- Sorting by clock text without dates or zones.
- Showing one event in both views after its boundary.
- Treating an empty view as service downtime.
- Assuming a listed event is accessible.

## Frequently asked questions

### Should the current event appear at the top of upcoming?

No, if the views use strict interval definitions. A separate now-and-next component can preserve context.

### How far ahead should upcoming go?

Use the shortest horizon that supports the task and remains within reliable source coverage.

### What if an event starts while I am viewing upcoming?

Refresh or transition it according to the guide clock, while preserving focus and announcing the state change.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [W3C: Labeling Controls](https://www.w3.org/WAI/tutorials/forms/labels/)
- [Norva: How It Works](https://norva.tv/#how-it-works)
