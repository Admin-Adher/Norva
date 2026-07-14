---
content_id: "NVB-097"
title: "TV Guide Information Missing or Incorrect? What to Check"
seo_title: "Missing TV Guide Information: Checks"
meta_description: "Troubleshoot missing or incorrect TV guide information by checking the source, date and time, filters, refresh state, control channels, and device comparison."
slug: "tv-guide-information-missing"
canonical_url: "https://norva.tv/blog/tv-guide-information-missing/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Product Evaluation & Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should I check when TV guide information is missing or incorrect?"
supporting_questions:
  - "How can I distinguish source data from a display problem?"
  - "What evidence should I send to support?"
audience:
  - "Norva TV guide users"
  - "People troubleshooting schedule metadata"
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
estimated_reading_minutes: 6
excerpt: "Guide information depends on the connected source data and current display context, so test a control channel and preserve the exact time window before resetting anything."
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
parent_pillar: "/blog/what-is-norva-media-player/"
related_articles:
  - "/blog/tv-guide-data-explained/"
  - "/blog/categories-not-updating-across-devices/"
  - "/blog/norva-troubleshooting-checklist/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "guide-window comparison grid"
  summary: "A grid compares one affected channel, one control channel, two time windows, and a second supported device."
  methodology: "Readers preserve exact schedule text, device time, filters, and source state, then change one variable per comparison."
  asset_urls: []
---

# TV Guide Information Missing or Incorrect? What to Check

> **In short:** Record the affected channel and time window, verify the device date and time, clear guide filters, and compare one known control channel. Norva displays information associated with the connected source; it cannot invent schedule data that the source does not expose. Refresh in small steps before reconnecting the source or clearing app data.

Guide problems generally fall into three observable groups: no information, information at the wrong time, or information attached to the wrong channel. Identify the group before attempting a fix.

## Preserve the exact example

Record:

- channel name and identifier shown;
- date and time window;
- programme title and description displayed, if any;
- expected information and how you verified it;
- connected source;
- account and profile;
- device, operating system, and app version;
- active guide, category, source, or favourites filters;
- screenshot without credentials or private source details.

“The guide is wrong” is difficult to reproduce. “Channel A shows no entry between 19:00 and 20:00 on this device” is actionable.

## Check date, time, and window

Confirm the device's date, time, and time-zone settings are correct according to the manufacturer's current instructions. Then check that the guide is showing today rather than a neighbouring date or a previously selected time.

Do not change several time settings merely to force the listing to line up. An incorrect manual adjustment can hide the cause and affect other apps. Record the original state first.

The [TV guide data explainer](/blog/tv-guide-data-explained/) separates channel identity, schedule metadata, time context, and playback availability.

## Clear display filters

A favourites-only, category, source, or search filter can make channels or entries appear missing. Return to the broadest guide view and clear one filter at a time.

If the entry reappears, reproduce the original filter and confirm the behaviour. A filtering issue does not require source removal or account sign-out.

## Compare an affected and control channel

Choose one channel whose guide information normally appears. Compare it with the affected channel in the same time window.

- If both are empty, investigate source guide reachability, account state, and refresh.
- If only one is empty, the source data for that channel is the stronger lead.
- If times shift equally across channels, inspect device time and time-zone context.
- If another supported device shows the same result, preserve that evidence before changing the TV.

This test narrows the layer without assuming a cause.

## Refresh in the least disruptive order

1. clear guide filters;
2. return to the current date and time;
3. use the in-app refresh route if exposed;
4. verify network connectivity;
5. close and reopen Norva;
6. restart the device;
7. compare another supported device under the same account and source;
8. check whether source data is available through its official route.

Do not immediately clear app storage or reconnect the source. The [Norva troubleshooting checklist](/blog/norva-troubleshooting-checklist/) explains when broad steps become reasonable.

## Original evidence: guide-window grid

| Check | Affected channel | Control channel |
| --- | --- | --- |
| Current programme shown |  |  |
| Next programme shown |  |  |
| Same time on Device B |  |  |
| Filters cleared | Yes / No | Yes / No |
| Source data verified | Yes / No / Unknown | Yes / No / Unknown |

Add device date, time zone, test time, and the evidence source for the expected listing. Do not rely on memory alone.

For a broader catalogue mismatch between devices, use the [category refresh troubleshooting guide](/blog/categories-not-updating-across-devices/).

## When to contact support

Contact the source provider when the schedule information is absent or wrong in the source's own official view. Contact Norva support when the source data is verified but Norva displays a reproducibly different result.

Share the grid, screenshots, device and app versions, source label, and exact time window. Never send passwords or secret source details.

## Common mistakes and limitations

- Reporting no exact channel, date, or time.
- Comparing schedules from different time zones without noting it.
- Leaving favourites or category filters active.
- Treating guide metadata as proof of current playback availability.
- Removing the source before testing a control channel.
- Using an unverified third-party listing as definitive evidence.
- Changing clock settings without recording the original values.

Schedule data can change. Recheck the source and expected listing close to the observed time.

## Frequently asked questions

### Why is the channel playable but its guide is empty?

Playback reachability and schedule metadata are separate. The source may expose media access without complete guide entries for that channel or time.

### Can Norva correct missing source schedule data?

Norva can display and organise data associated with the connected source, but it cannot invent source information that is absent. Verify the upstream data first.

### Should I change my device time zone?

Only when it is genuinely incorrect. Record the current setting and follow the device manufacturer's official guidance rather than shifting it to mask one guide mismatch.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva support](https://norva.tv/support)
