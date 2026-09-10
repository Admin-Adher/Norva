---
content_id: "NVB-721"
title: "Offline Video Storage: Free Space Without Resetting the App"
seo_title: "Manage Offline Video Storage and Remove Downloads Safely"
meta_description: "Downloads taking too much space? Reconcile app and device totals, remove finished offline videos safely and protect free space with a worked storage example."
slug: "offline-storage-management-handbook"
canonical_url: "https://norva.tv/blog/offline-storage-management-handbook/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "pillar-guide"
topic_cluster: "Offline Storage"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should I manage offline media storage responsibly?"
supporting_questions:
  - "How can offline media be distinguished from other app storage?"
  - "What is the safest order for reclaiming space?"
audience:
  - "People maintaining offline media on phones or tablets"
  - "Households coordinating storage across supported devices"
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
updated_at: "2026-09-10T20:52:12Z"
last_fact_check: "2026-09-10"
estimated_reading_minutes: 6
excerpt: "A completed before-and-after example explains why download totals differ from app storage and how to recover space without resetting the app or removing local settings."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/set-free-space-reserve-offline-media/"
  - "/blog/storage-for-offline-video/"
  - "/blog/offline-playback-explained/"
cta:
  label: "Check How Offline Playback Works"
  href: "https://norva.tv/blog/offline-playback-explained/"
  intent: "awareness"
sources:
  - "https://norva.tv/privacy"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
  - "https://support.google.com/android/answer/13627979?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "worked illustrative storage reconciliation"
  summary: "A fictional 8.0 GB download list is reconciled with a 10.2 GB app footprint before and after removing one 3.0 GB item, without labelling the unexplained balance as cache."
  methodology: "The completed example uses consistent decimal GB, explicitly invented figures and one item-level change. It is not a Norva download or deletion test."
  asset_urls: []
---

# Offline Video Storage: Free Space Without Resetting the App

> **In short:** Manage offline storage from two views: the app’s list of local items and the operating system’s storage report. Measure representative items, protect a device-specific free-space reserve, assign every batch an owner and review date, and remove finished items through the app first. Investigate unexplained growth one change at a time; never assume cache, app data, and offline media are interchangeable.

If your phone says an app uses 10 GB but its download list adds up to 8 GB, the remaining space is not automatically wasted. App code, settings, artwork and temporary data may also count. The task is to recover unnecessary local copies while keeping the account, preferences and media you still need.

## Understand the storage layers

Norva states that eligible offline media is encrypted and stored on the device, not uploaded to Norva. This app-managed local media is different from:

- catalogue metadata and artwork;
- playback progress and preferences that can sync;
- cache or temporary transfer data;
- application settings and credentials;
- unrelated files owned by other apps.

Local availability is also different from eligibility. A visible download entry does not prove that the intended version and all required tracks play without a connection. Use the [offline playback guide](/blog/offline-playback-explained/) for that separate check. Availability depends on the source, authorisation, supported device and current product conditions; this is not a promise that every Norva platform downloads every item.

## Build a reliable baseline

Open both the app's offline area and the device storage settings. Record current free space, the app's reported footprint, and the local items you can identify. Apple and Android both expose storage information, but their category names and accounting methods differ.

Measure a representative eligible item by noting storage before and after preparation, avoiding other transfers during the comparison. Treat the result as an observation for that device, item and version—not a universal size-per-hour rule. The [offline video storage estimate](/blog/storage-for-offline-video/) helps plan a batch; actual sizes remain the basis for maintenance.

## Protect working free space

Choose a reserve before adding media. The device needs room for normal activity, and your personal usage pattern determines how conservative the boundary should be. The [free-space reserve guide](/blog/set-free-space-reserve-offline-media/) uses observed device behaviour instead of a one-size-fits-all percentage.

After every few items, recheck free space. Stop before the next item would cross the boundary, even if it remains eligible.

## Give each item a purpose

Record the viewer, profile, planned session, required audio or subtitles, measured size, disconnected-test date, and cleanup date. Local items without a named purpose become difficult to distinguish from clutter.

Use a rotation with active, fallback, remove, and recheck states. Retain only one fallback for a credible alternative, and do not keep a failed or incomplete item simply because it consumed time to prepare.

## Remove storage in the safest order

Start with finished or unnecessary items inside the app. Confirm the exact item and read the removal message. Then wait for the operating system's storage display to refresh.

Next review other app downloads and clearly unused local files through their own controls. Avoid deleting internal app folders. On Android, clearing cache removes temporary data, while clearing storage removes app data; on Apple devices, offloading and deleting an app have different effects. Read the current platform wording before acting.

## Diagnose unexplained growth

If storage use changes unexpectedly, capture a new baseline and compare one category at a time. Check whether a transfer is still active, whether another app added files, and whether both storage reports have refreshed. A growing difference is worth investigating, but the difference alone does not identify a leak, cache or duplicate download.

Do not reinstall the app as an early diagnostic step. Norva's privacy policy says downloaded media is removed when the app is uninstalled.

## Coordinate more than one device

Each device has its own storage, battery, and planned viewer. Do not duplicate the entire batch automatically. A phone for the train and a tablet for the evening may need different items. Syncing progress or preferences does not mean the media bytes have been copied to the other device; verify its local availability separately.

## Original evidence: storage control ledger

This completed example uses **fictional figures, not a Norva device test**. A phone reports 12.0 GB free and a 10.2 GB app footprint. Its app lists three completed local items totalling 8.0 GB. All numbers use decimal GB and the same reporting time.

| Item or category | Size | Purpose | Decision |
| --- | --- | --- | --- |
| Finished travel video A | 3.0 GB | Previous journey completed | Remove only this local copy through the app |
| Planned video B | 4.0 GB | Upcoming evening viewing | Retain and test offline before departure |
| Short fallback C | 1.0 GB | Backup session | Retain until the return journey |
| App footprint minus listed downloads | 2.2 GB | Not itemised by these two reports | Leave alone; do not call the whole balance cache |

After removing A and letting the reports refresh, this illustrative phone shows **5.0 GB** of listed downloads, a **7.2 GB** app footprint and **15.0 GB** free. The 3.0 GB reduction is consistent with the chosen removal. The remaining 2.2 GB difference is unchanged and still not classified.

The household chooses a **6.0 GB reserve** for its own expected updates and activity. That leaves 9.0 GB above the reserve after cleanup, not 15.0 GB to fill. The reserve is an example, not an Android or Norva minimum; temporary preparation space and future device activity also matter.

If your actual free-space increase differs from the removed item's displayed size, do not repeat deletion blindly. Refresh both views, note other changes, and compare consistent units. Ask for help if a reproducible unexplained difference remains. Record safe item nicknames and rounded sizes, never source URLs or credentials.

## Common mistakes and limitations

- Treating all app storage as playable offline media.
- Applying one universal file-size estimate.
- Filling the device to its displayed limit.
- Clearing all app storage to remove one item.
- Manipulating encrypted app-managed files manually.
- Expecting storage reports to refresh instantly.
- Assuming a device transfer preserves local media.
- Keeping old batches without review dates.

## Frequently asked questions

### Why do the app and device totals differ?

The device may include app code, settings, cache, temporary data, and local media, while the app may show only completed offline items. Timing and category rules can also differ.

### Is clearing cache the same as removing offline media?

Do not assume so. Cache normally refers to temporary data, while offline media is a deliberate local item. Use the app's item-level removal first.

### Will clearing storage remove my settings or downloads?

Android describes Clear storage as removing all app data. It is not a download-only cleanup control. Do not use it to remove one video. Read the app's removal prompt and retain account recovery information before considering any broader reset through official support guidance.

### Should every device keep the same batch?

No. Allocate by planned viewer, journey, battery, storage, and reliability. Verify every device independently.

## Your next step

[Check how offline playback works](https://norva.tv/blog/offline-playback-explained/) before your next journey. Start with one compatible item you are authorised to use, verify its required tracks on the intended device, and keep a review date for its local copy. Norva is a media player, not a supplied content library.

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up storage](https://support.google.com/android/answer/7431795?hl=en)
- [Android Help: Manage unused apps](https://support.google.com/android/answer/13627979?hl=en)
