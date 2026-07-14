---
content_id: "NVB-903"
title: "Now-and-Next Information Looks Stale: Build a Timeline"
seo_title: "Now-and-Next Looks Stale? Build a Timeline"
meta_description: "Diagnose stale now-and-next information by recording source schedule changes, device clock and zone, channel identity, guide state, devices, and timestamps."
slug: "now-next-information-stale"
canonical_url: "https://norva.tv/blog/now-next-information-stale/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "now-next-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose stale now-and-next guide information?"
supporting_questions:
  - "Which source schedule, clock, zone, channel identity, guide state, device, and timestamp evidence belongs in the timeline?"
  - "How can stale text be distinguished from a start-time or channel mismatch?"
audience:
  - "Norva users seeing old current-program information"
  - "Households comparing live guide data"
author: { name: "", profile_url: "" }
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
excerpt: "A now-and-next timeline aligns source schedule changes, exact channel identity, device clock and zone, guide observations, device versions, and user actions."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/program-start-time-disagrees-live/"
  - "/blog/guide-refresh-delayed-after-source-update/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Consult Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.iana.org/time-zones"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "now-and-next observation timeline"
  summary: "A timeline records exact channel identity, source current and next listings, source confirmation time, device clock and zone, Norva current and next text by view, guide refresh sequence, device and application version, and user actions."
  methodology: "The user samples one affected and one control channel, records source and Norva observations at planned timestamps, keeps guide context stable, avoids repeated refreshes, and distinguishes text, time, and channel mismatches."
  asset_urls: []
---

# Now-and-Next Information Looks Stale: Build a Timeline

> **In short:** Select one affected channel and one control, then record exact channel identity, source current and next listings, source confirmation time, device clock, time zone, Norva current and next text by view, device, application version, and every refresh or navigation action. Observe at documented times without repeated requests. Classify stale text, wrong channel, wrong time window, delayed source update, device-specific display, or unknown rather than assuming a refresh mechanism.

“Stale” means a previous listing remains visible after the point when a newer source schedule observation suggests it should differ. That definition requires channel, time, and text evidence.

## Confirm channel identity

Record source label, channel name, number or identifier where visible, logo state, region or version cue, and guide row. Same-name channels can carry different schedules. Do not compare by name alone.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the identity and time matrix.

## Record device time context

Capture device-local clock, time zone name, UTC offset where visible, automatic or manual time state, selected date, and guide window. An incorrect clock can make a correct listing appear old.

## Capture the source sequence

Through the provider's official authorized route, record the current and next program titles, start and end times, and confirmation timestamp for the exact channel. Use short title cues when privacy requires. Do not assume the source schedule itself is final or unchanged.

## Capture Norva by view

Record current and next text on the guide grid, channel detail, or other relevant view. Note start and end times, selected cell, and timestamp. A stale value limited to one screen is a view-specific observation.

## Plan observation points

Record a baseline before the expected source transition, one observation around it, and one afterward. If you missed an interval, state the gap. Do not describe continuous monitoring when the screen was not observed.

## Distinguish text from start-time mismatch

If the title changes but its start time disagrees with what is live, use the [program-time comparison](/blog/program-start-time-disagrees-live/). If both title and times belong to another channel, investigate mapping instead of refresh timing.

## Preserve the refresh sequence

Record source schedule change, any guide refresh request, visible acknowledgment, first Norva change, application navigation, device sleep or resume, and current state. The [delayed refresh timeline](/blog/guide-refresh-delayed-after-source-update/) expands that sequence.

Use only timing guidance published by current Norva support. Otherwise report elapsed observation without a universal threshold.

## Compare a control channel

Choose one nearby channel whose current and next listings change normally in the same guide window. Record identical fields. A healthy control narrows scope but does not reveal why the affected listing differs.

## Compare another supported device

Use the same account, profile, source, channel, filters, guide window, clock context, and close timestamp. Record both application versions. Different now-and-next text on one screen is cross-device evidence, not proof of local storage behavior.

## Avoid schedule edits and repeated refreshes

Do not rename programs, change channel identifiers, edit time zones, remove the source, clear application data, or issue repeated refreshes before preserving the first timeline. Each action creates a new sequence.

## Classify the result

Use source schedule unchanged, source schedule changed, wrong channel identity, device time mismatch, wrong guide window, one-view old text, one-device difference, changed after documented action, or unknown. Keep hypotheses about refresh or caching separate.

## Prepare support evidence

Use the [guide evidence template](/blog/guide-issue-support-evidence/) with masked channel cues, short listing text, source and Norva times, device clock and zone, observation points, control channel, devices, versions, and actions.

## Original evidence: now-and-next timeline

| Time | Source current/next | Norva current/next | Device and guide context | Action |
| --- | --- | --- | --- | --- |
| Baseline |  |  |  | None |
| Expected transition |  |  |  |  |
| Later observation |  |  |  |  |
| Other device |  |  |  | Compare |

## Common mistakes and limitations

- Comparing same-name but different channels.
- Ignoring device clock, zone, and guide window.
- Relying on memory instead of timestamped text.
- Repeating refreshes and losing the first sequence.
- Treating a control channel as proof of a cause.
- Sharing complete private schedules.

## Frequently asked questions

### When is now-and-next officially stale?

Use current Norva support guidance if it defines a threshold. Otherwise report exact source and screen timestamps.

### Should I keep refreshing the guide?

No. Preserve the first sequence and repeat only when current support guidance requests a controlled test.

### What if only the title is old?

Record title and time fields separately by view. A text-only difference needs a narrower classification than an entire channel mismatch.

## Your next step

[Consult Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
