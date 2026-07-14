---
content_id: "NVB-907"
title: "Overlapping Guide Listings? Separate Data From Layout"
seo_title: "Overlapping Guide Listings? Data or Layout"
meta_description: "Troubleshoot overlapping guide entries by comparing source intervals, channel identity, Norva detail values, grid geometry, focus, device, version, and timing."
slug: "overlapping-guide-listings-troubleshoot"
canonical_url: "https://norva.tv/blog/overlapping-guide-listings-troubleshoot/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "guide-overlap-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot overlapping program guide entries?"
supporting_questions:
  - "How can source time intervals, channel identity, detail values, grid geometry, focus, device, version, and timing be separated?"
  - "How can schedule overlap be distinguished from visual cell overlap?"
audience:
  - "Norva users seeing guide cells overlap"
  - "Households using a remote-controlled guide"
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
excerpt: "An overlap check compares source intervals and Norva detail times independently from grid cell geometry, clipping, focus, device, application version, and display context."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/program-start-time-disagrees-live/"
  - "/blog/tv-guide-scroll-performance/"
  - "/blog/tv-guide-focus-stuck/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Review Norva Guide Help"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "guide data and layout overlap comparison"
  summary: "A comparison records channel identity, adjacent source listings and intervals, Norva grid and detail times, cell positions and clipping, focus order, display size and scaling, device and application version, guide window, and timestamp."
  methodology: "The user checks adjacent listings in source and detail views, records whether intervals truly overlap, then independently documents visual geometry and focus on affected and control rows across one other supported device."
  asset_urls: []
---

# Overlapping Guide Listings? Separate Data From Layout

> **In short:** Select one affected row and one control. Record exact channel identity, adjacent source listings and start/end intervals, Norva grid and detail times, cell positions, clipping, focus order, display size or scaling, device, application version, guide window, and timestamp. First decide whether time intervals truly overlap or only grid cells overlap visually. Compare another supported device and avoid editing schedules or resetting the application before preserving both evidence layers.

Two programs can overlap in the source schedule, while two cells can also cover each other even when their underlying times are sequential. Those cases require different support evidence.

## Confirm the affected channel

Record source label, channel name, number or identifier where visible, logo state, and row position. Same-name channels can carry different schedules, so identity must be stable before comparing intervals.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the complete identity matrix.

## Record adjacent source intervals

Through the provider's official authorized route, capture the previous, affected, and next listing titles as short cues, plus exact start and end times and confirmation timestamp. Write intervals in the displayed format and record any explicit zone label.

## Test for data overlap

Compare the previous end with the next start. Mark gap, exact boundary, or overlap. Do not infer whether an overlap is valid, erroneous, or intentionally scheduled; simply preserve the source intervals.

## Record Norva detail values

Open each listing detail where supported and record title cue, start, end, channel, and date. Detail values can reveal whether the grid contains overlapping data or only paints cells incorrectly. Do not assume detail and grid share an undocumented data path.

## Record visual geometry

Note whether cells cover text, occupy the same horizontal range, spill into another row, clip titles, obscure the time header, or render beyond the visible window. Record display resolution or scaling only where the device exposes it safely.

## Check visible focus

Using ordinary remote navigation, record which cell has focus, direction pressed, next focused item, and whether the outline becomes hidden beneath another cell. The [focus diagnostic](/blog/tv-guide-focus-stuck/) applies when movement, rather than layout, is the main symptom.

## Freeze guide context

Record account, profile, source, channel group, filters, selected date, guide window, device clock and zone, device model, operating system, application version, and timestamp.

## Compare a control row

Choose one nearby row with sequential listings of similar durations. Record the same interval, geometry, and focus observations. A control that renders normally limits the scope but does not prove the affected cause.

## Compare another supported device

Use the same account, profile, source, channel, guide window, filters, and close time. Record application versions and display contexts. If only one screen overlaps visually while detail times match, preserve that result without naming a rendering cause.

## Separate performance symptoms

If cells appear correctly after delayed movement or frames feel slow, use the [guide scrolling comparison](/blog/tv-guide-scroll-performance/). Slowness, layout overlap, and schedule overlap should remain separate classifications.

## Avoid schedule or display guessing

Do not alter start/end times, rename programs, change channel identities, adjust unsupported display settings, clear application data, or repeat refreshes before saving evidence. The [live start-time guide](/blog/program-start-time-disagrees-live/) handles a real-world boundary mismatch.

## Classify the overlap

Use source intervals overlap, Norva detail intervals overlap, grid cells overlap but times do not, text clipping only, focus hidden by cell, one-row layout difference, one-device difference, changed after documented action, or unknown.

## Prepare support evidence

Use the [guide evidence template](/blog/guide-issue-support-evidence/) with masked channel, adjacent intervals, detail values, grid screenshot after redaction, focus path, display context, devices, versions, and timeline.

## Original evidence: data and layout comparison

| Evidence | Previous | Affected | Next |
| --- | --- | --- | --- |
| Source interval |  |  |  |
| Norva detail interval |  |  |  |
| Grid cell range |  |  |  |
| Text clipping |  |  |  |
| Focus result |  |  |  |

Record device, display context, guide window, and timestamp separately.

## Common mistakes and limitations

- Calling visual overlap a schedule-data overlap.
- Comparing the wrong same-name channel.
- Ignoring detail values and guide window.
- Treating hidden focus as missing data.
- Editing schedule times before evidence capture.
- Sharing an unredacted complete guide screenshot.

## Frequently asked questions

### Can two source listings legitimately overlap?

Record the source intervals and provider context without deciding validity. The provider or qualified support can interpret its schedule data.

### What if detail times are correct but cells overlap?

Classify a visual layout difference and preserve device, display, version, focus, and screenshot evidence.

### Should I change display scaling?

Only through official device guidance and after preserving the original context. Do not use unsupported settings as a shortcut.

## Your next step

[Review Norva Guide Help](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
