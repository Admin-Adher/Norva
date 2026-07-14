---
content_id: "NVB-723"
title: "How to Find Unexpected Offline Storage Use"
seo_title: "Find Unexpected Offline Storage Use"
meta_description: "Diagnose unexpected storage growth by comparing app and device views, completed items, partial transfers, cache, app data, and unrelated changes safely."
slug: "find-unexpected-offline-storage-use"
canonical_url: "https://norva.tv/blog/find-unexpected-offline-storage-use/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Offline Storage"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose unexpected offline storage consumption?"
supporting_questions:
  - "Why can app and operating-system totals differ?"
  - "Which checks are safe before clearing app data?"
audience:
  - "Existing users investigating unexplained app storage"
  - "People whose free space changed after offline preparation"
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
estimated_reading_minutes: 7
excerpt: "A layered storage diagnostic compares item-level offline media with app code, cache, data, partial transfers, system accounting, and unrelated device changes."
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
  - "/blog/app-data-vs-offline-media-storage/"
  - "/blog/remove-offline-downloads/"
  - "/blog/set-free-space-reserve-offline-media/"
cta:
  label: "Get Norva Support for a Documented Issue"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/privacy"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
  - "https://support.google.com/android/answer/13627979?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "one-change-at-a-time storage diagnostic log"
  summary: "A log captures timestamps, app and device totals, item state, recent changes, one corrective action, and the resulting measurement."
  methodology: "Readers preserve the initial evidence, avoid reinstalling or clearing all storage, and change only one supported layer before measuring again."
  asset_urls: []
---

# How to Find Unexpected Offline Storage Use

> **In short:** Capture the device and app storage views before changing anything. Compare completed offline items with partial transfers, cache, app data, temporary files, recent updates, and unrelated device growth. Remove one known local item through the app, wait for storage reporting to refresh, and measure again. Avoid clearing all app storage or reinstalling until evidence is preserved.

Unexpected storage use is a symptom, not a diagnosis. A larger app footprint can include playable local media, app code, settings, cache, indexes, temporary transfer data, or reporting delay.

## Preserve the starting evidence

Record the date, device, operating-system version, Norva app version, current free storage, and the app's reported size. Then list completed, queued, failed, and recently removed offline items.

Take screenshots only when they do not expose account details or source credentials. Do not start cleanup before this baseline exists, because the before state is needed to judge any change.

## Compare the two storage views

The app may list completed local items, while the operating system reports the app package and several data categories together. Apple notes that cached and temporary data can be accounted for differently. Android distinguishes storage from memory and explains that clearing cache and clearing storage have different effects.

Use the [app data versus offline media guide](/blog/app-data-vs-offline-media-storage/) to label each observed category without treating the totals as identical.

## Review recent changes

Build a short timeline:

- offline items prepared, retried, or removed;
- an interrupted transfer;
- app or operating-system updates;
- profile or account changes;
- photos, messages, maps, or other app downloads;
- device backup or restore activity;
- storage optimisation or unused-app features.

Correlation does not prove cause, but the timeline identifies the next layer to inspect.

## Test one known item

Choose a completed local item that is no longer needed. Record its displayed or observed size, remove it through Norva's own offline control, and leave the app stable. Wait for the operating system's storage view to refresh, then record both views again.

Norva states that eligible offline media is encrypted and stored on the device. Use the [offline removal workflow](/blog/remove-offline-downloads/) instead of manipulating internal files.

If storage falls roughly as expected, repeat item-level cleanup only as needed. If it does not, do not immediately clear all app storage; proceed to the next layer.

## Distinguish cache from persistent app data

On Android, clearing cache removes temporary data, while clearing storage permanently removes all app data. Apple offers app offloading and deletion with different consequences. Platform labels and effects vary, so read the exact current warning.

Uninstalling is not a neutral test. Norva's privacy policy says downloaded media is removed when the app is uninstalled. Preserve account and support evidence first.

## Check whether the device total changed elsewhere

Compare other storage categories. A coincidental photo import, system update, or another app's download can make free space shrink while the media app remains stable. Use the [free-space reserve worksheet](/blog/set-free-space-reserve-offline-media/) to see whether the unexplained change crosses your planning boundary.

## Original evidence: diagnostic log

| Time | App total | Device free space | Offline item state | One action | Result |
| --- | --- | --- | --- | --- | --- |
| Before |  |  |  | None | Baseline |
| After |  |  |  |  | Expected / Unclear |

Add recent changes and screenshots by filename, not sensitive content. If escalation is needed, provide the log to Norva support without passwords or source credentials.

## Common mistakes and limitations

- Clearing data before recording a baseline.
- Assuming every app byte is offline media.
- Deleting multiple categories at once.
- Expecting storage reporting to update instantly.
- Using uninstall as the first diagnostic step.
- Ignoring another app or system update.
- Sending sensitive account information in a support report.

## Frequently asked questions

### Why did free space not change immediately after removal?

Storage accounting can refresh later, and temporary data may remain. Wait, recheck both views, and avoid repeating broad actions rapidly.

### Is it safe to clear cache?

Read the current platform and app guidance. Cache is intended as temporary data, but clearing it is not the same as removing a known offline item and may affect performance temporarily.

### When should I contact support?

Escalate after preserving a baseline, reproducing the change with one item, and ruling out obvious device-wide growth. Share observations, not credentials.

## Your next step

[Get Norva support for a documented issue](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up storage](https://support.google.com/android/answer/7431795?hl=en)
- [Android Help: Manage unused apps](https://support.google.com/android/answer/13627979?hl=en)
