---
content_id: "NVB-904"
title: "Guide Listings Shifted by One Hour? Check Time Context"
seo_title: "Guide Listings Shifted by One Hour"
meta_description: "Troubleshoot listings offset by one hour by comparing device clock, time zone, UTC offset, daylight-saving context, guide window, source times, and devices."
slug: "guide-listings-shifted-one-hour"
canonical_url: "https://norva.tv/blog/guide-listings-shifted-one-hour/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "guide-time-offset-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot guide listings offset by one hour?"
supporting_questions:
  - "Which clock, time-zone, offset, daylight-saving, guide-window, source-time, device, and travel evidence should be compared?"
  - "How can a universal shift be separated from one-channel schedule data?"
audience:
  - "Norva users seeing a one-hour guide offset"
  - "Households near a clock or daylight-saving change"
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
excerpt: "A one-hour offset check compares device clock, time-zone name, UTC offset, daylight-saving context, guide window, source timestamps, affected channel scope, and another device."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/guide-timezone-wrong-after-travel/"
  - "/blog/program-start-time-disagrees-live/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Review Guide Support"
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
  type: "one-hour guide offset matrix"
  summary: "A matrix records device clock, automatic-time state, time-zone name, UTC offset, daylight-saving transition context, selected guide date and window, source listing times, Norva listing times, channel scope, device and application version, and travel history."
  methodology: "The user samples affected and control channels, compares source and Norva times without manual correction, verifies another supported device, records before and after a documented time-context change, and avoids inventing conversion rules."
  asset_urls: []
---

# Guide Listings Shifted by One Hour? Check Time Context

> **In short:** Record device-local clock, automatic or manual time state, time-zone name, UTC offset, recent daylight-saving or travel change, selected guide date and window, exact channel identity, source listing times, Norva listing times, device, and application version. Sample several channels to determine whether the shift is universal or isolated. Compare another supported device, and avoid manually offsetting source schedules before identifying which time context differs.

An exact one-hour difference often points investigators toward time context, but it does not prove a daylight-saving cause. Source timestamps, device settings, guide selection, and channel scope must be compared.

## Confirm the offset precisely

Choose two listings and record source and Norva start and end times in their displayed formats. Calculate the visible difference without rounding. Confirm whether it is exactly one hour, approximately one hour, or changes across listings.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the full time and identity matrix.

## Check multiple channels

Sample two affected channels and one control. If every listing is shifted by the same amount, the evidence differs from one channel having incorrect schedule data. Do not export the complete guide.

## Record device clock state

Capture device-local date and time, automatic or manual setting, time-zone name, UTC offset where visible, and last travel or clock-setting change. Do not turn automatic time off merely to force alignment.

## Record daylight-saving context

Note whether the observation is near a seasonal clock transition for the relevant named time zone. IANA publishes time-zone data, but a database rule does not establish which version a particular device, source, or application currently uses.

## Verify the guide window

Record selected date, visible guide header times, current-time marker where shown, and navigation position. A grid opened to the previous or next hour can mimic a uniform offset.

## Verify source time semantics

Through the provider's official authorized route, capture the source's displayed listing times, time zone or offset only where explicitly labeled, and confirmation timestamp. Do not assume unlabeled times are local, UTC, or tied to the channel's region.

## Compare Norva fields by view

Record grid cell, program detail, now-and-next, and current-time marker only where relevant. A one-hour difference limited to one view is different from a guide-wide conversion.

## Separate start-time mismatch from live content

If the grid time and source time agree but the currently playing program differs, use the [live start-time record](/blog/program-start-time-disagrees-live/). Schedule data and observed live content are separate evidence.

## Consider travel context

If the device recently moved, record origin and destination time-zone names without unnecessary location detail, when automatic time changed, and when the guide was first opened. Use the [post-travel recovery check](/blog/guide-timezone-wrong-after-travel/) rather than editing source times.

## Compare another supported device

Use the same account, profile, source, channel, filters, date, and close timestamp. Record both clocks, zones, operating systems, and application versions. One correct device narrows the symptom but does not identify the faulty layer.

## Avoid manual compensation

Do not add or subtract an hour in source data, rename channel time zones, change device clocks, clear application data, or repeat refreshes before preserving the matrix. Compensation can make one date look correct while creating another mismatch.

## Classify the result

Use exact guide-wide offset, one-channel source difference, selected-window difference, device clock mismatch, time-zone name mismatch, UTC-offset mismatch, transition-related observation, travel-related observation, one-view difference, one-device difference, or unknown.

## Prepare support evidence

Use the [guide issue record](/blog/guide-issue-support-evidence/) with paired times, zone and offset, sampled channels, view, device versions, travel or transition context, and actions. Exclude full location and source credentials.

## Original evidence: one-hour offset matrix

| Field | Device A | Device B or source |
| --- | --- | --- |
| Local clock and date |  |  |
| Time-zone name and offset |  |  |
| Automatic or manual time |  |  |
| Guide date and window |  |  |
| Sample listing start/end |  |  |
| Transition or travel context |  |  |
| App version and timestamp |  |  |

## Common mistakes and limitations

- Assuming exactly one hour always means daylight saving.
- Comparing unlabeled source and local times.
- Looking at one channel only.
- Manually offsetting schedules before saving evidence.
- Ignoring selected guide date and window.
- Sharing precise travel details unnecessarily.

## Frequently asked questions

### Should I manually change the device clock?

Not as a diagnostic shortcut. Record the current state and follow official device and Norva guidance.

### Does IANA data prove which time rule Norva uses?

No. It provides authoritative time-zone data, not evidence of a particular device or application implementation.

### What if only one channel is shifted?

Focus on exact channel identity and source schedule evidence rather than treating it as a universal device-time problem.

## Your next step

[Review Guide Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
