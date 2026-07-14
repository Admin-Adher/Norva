---
content_id: "NVB-727"
title: "How to Estimate How Many Offline Items Will Fit"
seo_title: "Estimate How Many Offline Items Will Fit"
meta_description: "Estimate offline capacity from measured item sizes, a protected free-space reserve, and a conservative range instead of a fixed items-per-device claim."
slug: "estimate-how-many-downloads-fit"
canonical_url: "https://norva.tv/blog/estimate-how-many-downloads-fit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to-guide"
topic_cluster: "Offline Storage"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can I estimate how many offline items will fit on my device?"
supporting_questions:
  - "Why is an exact item count unreliable?"
  - "How should a free-space reserve affect the estimate?"
audience:
  - "People planning an offline media batch"
  - "Travellers working with limited device storage"
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
  source_of_truth: "https://norva.tv/privacy"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6
excerpt: "A defensible offline capacity estimate uses measured examples, a device-specific reserve, and a range that accounts for item variation."
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
parent_pillar: "/blog/offline-storage-management-handbook/"
related_articles:
  - "/blog/set-free-space-reserve-offline-media/"
  - "/blog/prioritize-downloads-limited-storage/"
  - "/blog/storage-for-offline-video/"
cta:
  label: "Explore Norva's Offline Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://norva.tv/privacy"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "capacity range worksheet"
  summary: "A worksheet converts current free space, a protected reserve, and several observed item sizes into conservative low and high capacity estimates."
  methodology: "Readers measure representative eligible items on the target device, retain the largest observed size as a planning bound, and recalculate after each batch."
  asset_urls: []
---

# How to Estimate How Many Offline Items Will Fit

> **In short:** Estimate capacity on the target device, not from a generic hours-per-gigabyte rule. Subtract a protected free-space reserve from current availability, measure several representative eligible items, and divide the usable budget by both a typical and a larger observed size. Treat the result as a range, round down, and recheck storage after every small batch.

"How many items fit?" sounds like a simple division problem. It is not, because duration, media characteristics, available version, selected tracks, application handling, and the device's current state can all affect local storage use.

## Start with usable space, not total capacity

Open the device storage settings and record current free space. Do not begin with the storage number printed on the device box; the operating system, apps, photos, messages, and other files already consume part of it.

Choose a [free-space reserve](/blog/set-free-space-reserve-offline-media/) for updates, ordinary app activity, photos, communication, and other essential tasks. Then calculate:

**Usable offline budget = current free space - protected reserve**

If the result is zero or negative, the safe estimate is no additional items until space is reclaimed or the plan changes.

## Measure representative items

When offline use is supported for the device, compatible source, media, and associated rights, prepare a small sample that resembles the planned batch. Record device free space immediately before and after each completed item. Wait for storage reporting to settle before treating the difference as an observation.

Include different durations or types when the itinerary mixes them. Do not assume one episode represents a film, or that two items with the same duration have the same size. The broader guide to [reserving storage for offline video](/blog/storage-for-offline-video/) explains the variables behind these differences.

## Produce a range, not a promise

Use two observed values:

- a **planning size**, such as the middle of several comparable observations;
- a **conservative size**, preferably the largest relevant observation.

Divide the usable budget by each value and round down. The conservative division gives the lower capacity estimate; the planning division gives an upper working estimate. If you measured only one item, report a single provisional bound rather than disguising it as a reliable range.

Never add a fractional item. Also leave room for measurement error, temporary data, and normal device use by stopping short of the mathematical maximum.

## Prioritize before filling the budget

An item count is not a goal. Rank the planned sessions, required tracks, viewer needs, and fallback value. The [limited-storage prioritization method](/blog/prioritize-downloads-limited-storage/) helps retain high-value items while dropping low-confidence extras.

Prepare in small batches. After each batch:

1. confirm every item completed;
2. verify required audio and subtitles;
3. test one or more items without connectivity;
4. recheck device free space;
5. recalculate the remaining range.

This feedback loop catches a bad estimate before it consumes the entire reserve.

## Original evidence: capacity range worksheet

| Input | Observation |
| --- | --- |
| Current device free space |  |
| Protected reserve |  |
| Usable offline budget |  |
| Sample item A size |  |
| Sample item B size |  |
| Sample item C size |  |
| Planning size |  |
| Conservative size |  |
| Rounded-down capacity range |  |

Below the table, list each sample's duration, version, audio, subtitles, device, and measurement time. That context makes the estimate reproducible rather than transferable to unrelated devices.

## Common mistakes and limitations

- Dividing advertised device capacity by a generic item size.
- Ignoring the operating system and other local data.
- Using one short item as the average for a mixed batch.
- Failing to reserve space for essential non-media tasks.
- Counting incomplete preparation as usable offline media.
- Treating the upper estimate as a guaranteed capacity.
- Applying one device's measurements to another device.

## Frequently asked questions

### Can duration alone predict local size?

No. Duration helps group comparable items, but media characteristics, versions, tracks, and app handling can still change the observed size.

### Should I use the smallest or largest sample?

Use a typical relevant observation for the upper working estimate and the largest relevant observation for the conservative lower estimate. Round both down.

### Why does the estimate change after preparation?

The original sample may not represent the next items, and storage reporting or temporary data can change. Recalculation is part of the method, not evidence that estimation is useless.

## Your next step

[Explore Norva's offline features](https://norva.tv/#features)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up storage](https://support.google.com/android/answer/7431795?hl=en)
