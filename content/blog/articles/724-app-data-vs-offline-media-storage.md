---
content_id: "NVB-724"
title: "App Data vs. Offline Media: Know What Uses Storage"
seo_title: "App Data vs. Offline Media Storage"
meta_description: "Understand app code, settings, cache, temporary files, and offline media before removing storage so one local item does not trigger a broad reset."
slug: "app-data-vs-offline-media-storage"
canonical_url: "https://norva.tv/blog/app-data-vs-offline-media-storage/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "educational-explainer"
topic_cluster: "Offline Storage"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How does app data differ from offline media storage?"
supporting_questions:
  - "What can an operating system include in an app total?"
  - "Why is clearing all app data a broad action?"
audience:
  - "People reviewing a media app's storage footprint"
  - "Users deciding how to reclaim local space safely"
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
excerpt: "An app's storage total can include code, settings, cache, indexes, temporary files, and deliberate offline media, each requiring a different removal decision."
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
  - "/blog/where-offline-downloads-live/"
  - "/blog/cache-or-app-data-know-what-a-mobile-reset-removes/"
  - "/blog/find-unexpected-offline-storage-use/"
cta:
  label: "Read Norva's Device-Storage Privacy Details"
  href: "https://norva.tv/privacy"
  intent: "awareness"
sources:
  - "https://norva.tv/privacy"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "storage-layer classification map"
  summary: "A map separates app package, account settings, cache, indexes, transfer data, and completed offline media by purpose and safest control."
  methodology: "Readers classify observed categories from current device labels and choose the narrowest supported action rather than inferring contents from one total."
  asset_urls: []
---

# App Data vs. Offline Media: Know What Uses Storage

> **In short:** “App storage” is an umbrella total. It can include the installed app, account settings, indexes, cache, temporary transfer data, and completed offline media. Offline media is a deliberate local copy; cache is temporary support data; clearing all app storage is a much broader action. To reclaim one item’s space, use the app’s item-level offline removal first.

Storage settings often show one large number beside an app. That number does not tell you which part is a playable local item or which action is safe. Understanding the layers prevents a narrow cleanup need from becoming an account or setup reset.

## The app package

The installed application itself consumes storage. Its size can change after updates. Removing the package is not equivalent to removing one offline item.

Apple distinguishes offloading an app from deleting it: offloading frees app storage while retaining documents and data, whereas deletion removes the app and related data. Available options vary. On Android, uninstalling removes the app, and reinstalling may not restore every local state.

## Settings and persistent app data

Persistent data can include account context, preferences, local indexes, configuration, and other information needed for normal use. Some account state can also exist in the cloud, but that does not make every local setting disposable.

Android explicitly distinguishes **clear cache** from **clear storage**: clearing storage permanently deletes app data. The exact consequences depend on the app and device, so read the warning before proceeding. The guide to [what a mobile reset removes](/blog/cache-or-app-data-know-what-a-mobile-reset-removes/) covers that decision in detail.

## Cache and temporary files

Cache generally stores data that can help an app load or operate efficiently. Temporary transfer data can also exist while an offline item is queued or incomplete. These categories are not automatically the same as a completed, playable local copy.

Storage reports may omit, merge, or refresh categories at different times. Do not infer a fault merely because the app's visible offline item sizes do not exactly equal the operating system total.

## Completed offline media

Norva's privacy policy states that eligible offline media is encrypted and stored on the device and is not uploaded to Norva. This local media should be managed through the app's offline controls.

The [device-versus-cloud guide](/blog/where-offline-downloads-live/) distinguishes local media from progress, history, favourites, and preferences that can sync across supported devices. Local availability remains conditional on the device, compatible source, media, and associated rights.

## Choose the narrowest action

When reclaiming space:

1. identify a finished or unnecessary offline item;
2. remove it through the app;
3. wait for storage reporting to refresh;
4. compare app and device views;
5. inspect cache or broader app data only if the symptom remains;
6. preserve account and support evidence before any reset or uninstall.

If totals remain unexplained, use the [unexpected storage diagnostic](/blog/find-unexpected-offline-storage-use/) one change at a time. The [offline storage handbook](/blog/offline-storage-management-handbook/) supplies the complete maintenance order.

## Original evidence: storage-layer map

| Layer | Purpose | Observable clue | Narrowest control |
| --- | --- | --- | --- |
| App package | Runs the software | Installed app size | Platform app management |
| Persistent data | Settings and local state | App data category | App or platform guidance |
| Cache | Temporary support data | Cache category where exposed | Supported cache control |
| Transfer data | In-progress preparation | Queue or partial state | In-app cancel/retry |
| Offline media | Deliberate local playback | Completed offline item | In-app item removal |

Mark unknown categories as “needs investigation.” Do not assign contents solely from size.

## Common mistakes and limitations

- Treating the operating system's app total as only offline media.
- Clearing all app storage to remove one item.
- Assuming cache removal deletes completed offline media or vice versa.
- Uninstalling before recording local items and account state.
- Moving encrypted app-managed files manually.
- Expecting exact agreement between two storage screens.
- Treating cloud-synced progress as cloud storage of the media file.

## Frequently asked questions

### Is cache safe to clear?

Follow current platform and app guidance. Cache is designed as temporary data, but clearing it may slow the next launch and is not the same as item-level removal.

### Does clearing app storage sign me out?

It can remove app data and setup state. Read the exact warning and preserve necessary non-sensitive evidence before acting.

### Why is offline media not visible in my normal video folder?

Norva describes eligible offline items as encrypted, app-managed device storage. Use Norva's offline area rather than expecting a transferable ordinary file.

## Your next step

[Read Norva's device-storage privacy details](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up storage](https://support.google.com/android/answer/7431795?hl=en)
