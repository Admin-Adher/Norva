---
content_id: "NVB-918"
title: "TV Guide Scrolling Feels Slow: Separate Data and Device Load"
seo_title: "TV Guide Scrolling Slow? Compare Context"
meta_description: "Troubleshoot slow guide scrolling by comparing grid density, guide window, focus path, device load, app version, overlays, repeat runs, and control screens."
slug: "tv-guide-scroll-performance"
canonical_url: "https://norva.tv/blog/tv-guide-scroll-performance/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "guide-scroll-performance-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot slow television guide scrolling?"
supporting_questions:
  - "Which grid density, guide window, focus path, device load, version, network, overlay, repeated run, and control-screen evidence should be compared?"
  - "How can subjective slowness be documented without inventing a performance target?"
audience:
  - "Norva TV users seeing slow guide movement"
  - "Households comparing supported devices"
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
excerpt: "A guide-scroll comparison records a repeatable remote path, visible grid density, device and application state, network, overlays, warm and repeat runs, and a control screen without promising a speed."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/tv-guide-focus-stuck/"
  - "/blog/overlapping-guide-listings-troubleshoot/"
  - "/blog/guide-works-on-one-device-only/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Review Guide Performance Help"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://developers.google.com/search/docs/appearance/core-web-vitals"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "repeatable guide scrolling observation sheet"
  summary: "A sheet records a short remote path, grid rows and time span visible, populated and empty cells, focus transitions, subjective pauses with timestamps, device and operating system, application version, network, storage and background context where visible, overlays, first and repeat runs, and control screen."
  methodology: "The user pauses between inputs, repeats the same short path under stable conditions, records observable stalls rather than invented metrics, compares a lighter guide window and another supported device, and separates focus, layout, network, and device-load evidence."
  asset_urls: []
---

# TV Guide Scrolling Feels Slow: Separate Data and Device Load

> **In short:** Define one short remote-navigation path and record grid rows, visible time span, populated cells, focus transitions, noticeable pauses, overlays, device, operating system, application version, network, storage or background context where visible, and timestamps. Repeat the same path after a stable pause, compare a lighter guide window and another supported device, and separate delayed focus, layout overlap, network loading, and general device response without inventing a speed target.

“Feels slow” is valid user evidence, but it becomes actionable when tied to a repeatable path and observable pauses. The goal is not a benchmark; it is to show where response changes under comparable conditions.

## Choose a short path

Define three to six directional moves from a known focused cell across rows or time. Record start and end, guide window, and expected focus sequence. Do not hold the remote button or queue many inputs.

The [focus transition diagnostic](/blog/tv-guide-focus-stuck/) applies when focus fails to move or lands unpredictably.

## Record grid density

Count visible channel rows approximately, note time span, number of populated versus blank cells in the path, long or overlapping listings, logos, and open details. Do not claim a hidden data volume or rendering cost.

## Record device context

Capture device model, operating system version, Norva application version, available storage where visible, device uptime or recent resume, and whether other ordinary applications also respond slowly. Avoid exposing unrelated installed applications or personal data.

## Record network context

Note wired or wireless connection in generic terms and whether guide cells are already populated before the path. If the screen visibly loads data during movement, record the loading state. Do not assume every pause is network-related.

## Record overlays and layout

Note search, filters, details, dialogs, or loading layers. If cells overlap or hide focus, use the [layout-overlap guide](/blog/overlapping-guide-listings-troubleshoot/) before calling scrolling slow.

## Run a baseline and repeat

Pause until the visible screen is stable, perform the path once, record observations, then repeat under the same context. Use timestamps or video only when privacy-safe and permitted, and avoid claiming frame rates without a proper measurement method.

## Compare a lighter guide window

Choose a nearby window or group with visibly fewer populated cells while keeping account, profile, device, and version stable. Record whether the same path differs. This comparison shows context sensitivity, not an internal load cause.

## Compare a control screen

Navigate a short documented path in another Norva screen or device interface. If remote response is slow everywhere, record broader device context. Do not turn a control screen into a performance guarantee.

## Compare another supported device

Use the same account, profile, source, group, filters, guide window, and path. Record both devices and application versions. The [cross-screen guide check](/blog/guide-works-on-one-device-only/) keeps data context aligned.

## Separate first and repeat runs

Record whether the first path after opening differs from the repeat path. Do not call it warm-up, caching, or preloading without verified evidence. Use neutral labels: first observation and repeat observation.

## Avoid destructive optimization

Do not clear application data, uninstall applications, change system performance settings, remove the source, reset the device, or alter network security before preserving the baseline. Follow official device and Norva guidance for later steps.

## Interpret standards carefully

Google's Core Web Vitals document web page experience metrics. Those targets do not establish a TV remote-scroll requirement or measure a native or embedded guide automatically. Cite them only for general web performance context.

## Classify the result

Use delayed focus, visually dense-window difference, first-versus-repeat difference, overlay-related pause, layout overlap, network-loading observation, broad device slowness, one-device difference, reproducible short-path pause, or unknown.

## Prepare support evidence

Use the [guide issue template](/blog/guide-issue-support-evidence/) with the exact path, grid context, first and repeat runs, device and version, network, overlays, control, other device, timestamps, and actions.

## Original evidence: scrolling observation sheet

| Run | Path | Grid context | Focus result | Observed pauses | Device/network |
| --- | --- | --- | --- | --- | --- |
| Baseline |  |  |  |  |  |
| Repeat |  |  |  |  |  |
| Lighter window |  |  |  |  |  |
| Other device |  |  |  |  |  |

## Common mistakes and limitations

- Holding buttons or queuing inputs.
- Mixing focus failure with delayed movement.
- Assuming dense data, network, or cache is the cause.
- Changing several device settings before comparison.
- Applying web metrics as a TV requirement.
- Recording private guide content unnecessarily.

## Frequently asked questions

### What counts as slow?

Describe repeatable observable pauses on a defined path. Do not invent a universal threshold without official product evidence.

### Should I clear application data?

Not before preserving a reproducible baseline and following current official support guidance.

### Does a faster second run prove caching?

No. Record first and repeat observations without assigning an undocumented mechanism.

## Your next step

[Review Guide Performance Help](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [Google Search Central: Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals)
