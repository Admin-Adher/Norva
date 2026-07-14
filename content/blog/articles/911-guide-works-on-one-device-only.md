---
content_id: "NVB-911"
title: "TV Guide Works on One Device Only: A Cross-Screen Check"
seo_title: "TV Guide Works on One Device Only"
meta_description: "Troubleshoot device-specific guide differences by matching account, profile, source, groups, filters, guide window, clock and zone, app version, and samples."
slug: "guide-works-on-one-device-only"
canonical_url: "https://norva.tv/blog/guide-works-on-one-device-only/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "cross-device-guide-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot device-specific guide differences?"
supporting_questions:
  - "Which account, profile, source, group, filter, guide-window, clock, zone, version, network, and sample contexts must match?"
  - "Which safe comparisons should happen before resetting a device?"
audience:
  - "Norva users seeing a guide on one screen only"
  - "Households using multiple supported devices"
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
excerpt: "A cross-screen guide check aligns account, profile, source, groups, filters, guide window, device clocks and zones, application versions, networks, and channel samples before resets."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/tv-guide-grid-empty/"
  - "/blog/guide-refresh-delayed-after-source-update/"
  - "/blog/tv-guide-focus-stuck/"
  - "/blog/tv-guide-scroll-performance/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Compare With Norva Support"
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
  type: "cross-screen guide context matrix"
  summary: "A matrix compares account, profile, source, channel group, filters, selected date and window, device clock and zone, channel and listing samples, device and application version, network, focus or layout state, timestamp, and documented actions."
  methodology: "The user aligns both screens, observes them close in time, compares a minimal channel sample, changes one reversible context, avoids local-data clearing first, and records data, time, navigation, and performance differences separately."
  asset_urls: []
---

# TV Guide Works on One Device Only: A Cross-Screen Check

> **In short:** Align both devices before diagnosing: use the same Norva account, profile, authorized source, channel group, filters, selected date, guide window, and close observation time. Record each device's clock, time zone, operating system, application version, network, channel rows, listing samples, focus, and layout. Change one reversible context, use only documented refresh behavior, and avoid clearing application data, reinstalling, or assuming a local cache cause first.

“Works” must be defined. One device may show channel rows and listings while the other is empty, stale, shifted, slow, visually overlapped, or impossible to navigate. Each difference has a separate branch.

## Define the cross-screen difference

Record whether the affected screen lacks rows, lacks listings, shows different times, displays old text, maps another program, traps focus, or scrolls slowly. Do not compress these observations into one device failure.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the layer matrix.

## Match account and profile

Verify the exact Norva account and active profile on both devices. Record recent sign-in, profile switch, household role, or device reassignment. Similar profile names are not enough.

## Match source, group, and filters

Record enabled source label, channel group, favorites or availability view, search query, and every filter. Remove one mismatch, compare, then restore baseline. A different group can make one guide appear complete and the other empty.

## Match date and guide window

Capture selected date, visible start and end times, current-time marker where shown, and focused cell. Navigate through the same documented path. One device may retain another guide position without proving schedule data differs.

## Compare clocks and zones

Record local date and time, named time zone, UTC offset where visible, and automatic or manual state. Compare close in time. A zone difference can shift listings even when both devices receive the same source schedule.

## Compare a minimal channel sample

Choose one affected channel, one control, and one adjacent or duplicate-looking channel when relevant. Record source and visible identifiers, current and next listing cues, and start/end times. Avoid complete guide screenshots.

If the affected screen is completely blank, use the [empty-grid checklist](/blog/tv-guide-grid-empty/).

## Record device and network context

Capture model, operating system, Norva application version, network type, foreground or resumed state, and available storage only where relevant and visible. These are context differences, not proven causes.

## Separate data from navigation

If listings are visible but remote focus cannot reach them, use the [focus diagnostic](/blog/tv-guide-focus-stuck/). If focus moves but frames respond slowly, use the [scrolling comparison](/blog/tv-guide-scroll-performance/). Do not reset schedule data for a navigation symptom.

## Use documented refresh behavior

Follow current Norva support for any non-destructive navigation, refresh, or sign-in step. Record before and after. The [delayed-refresh timeline](/blog/guide-refresh-delayed-after-source-update/) applies when one device changes later after a source update.

## Preserve local state

Do not clear application data, erase downloads, reinstall, reset the device, remove the source, change the clock, or repeat refreshes before saving paired evidence. Those actions can remove useful session or diagnostic context.

## Classify the result

Use account or profile mismatch, source or group mismatch, filter difference, guide-window difference, clock or zone difference, application-version difference, network-specific observation, data difference, layout difference, focus difference, performance difference, resolved by documented step, or unknown.

## Prepare paired support evidence

Use the [guide evidence template](/blog/guide-issue-support-evidence/) with both contexts, close timestamps, sampled channels, clocks and zones, versions, networks, navigation or layout evidence, and actions.

## Original evidence: cross-screen guide matrix

| Context | Device A | Device B | Same? |
| --- | --- | --- | --- |
| Account and profile |  |  |  |
| Source, group, filters |  |  |  |
| Date and guide window |  |  |  |
| Clock and time zone |  |  |  |
| Channel and listing samples |  |  |  |
| Focus and layout |  |  |  |
| Device, version, network |  |  |  |

## Common mistakes and limitations

- Comparing different profiles, groups, or guide windows.
- Ignoring device clock and time zone.
- Treating data, focus, layout, and speed as one symptom.
- Clearing local data before paired evidence exists.
- Naming cache or storage as the cause without proof.
- Capturing complete private channel lists.

## Frequently asked questions

### Should I reinstall the application first?

No. Align contexts and preserve paired evidence before following any destructive step in current official guidance.

### Does one working device prove the source is correct?

It proves the sampled guide appears on that device in that context, not that every layer is identical.

### What if the clocks differ?

Record named zones, offsets, automatic settings, and guide windows before changing time or schedule data.

## Your next step

[Compare With Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
