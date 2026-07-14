---
content_id: "NVB-731"
title: "Why the Offline Download Location Matters"
seo_title: "Why the Offline Download Location Matters"
meta_description: "Understand where eligible offline media is stored, why app-managed local files differ from synced account data, and which controls to use safely."
slug: "verify-offline-download-location"
canonical_url: "https://norva.tv/blog/verify-offline-download-location/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "explanatory-guide"
topic_cluster: "Offline Storage"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Why does the offline download location matter?"
supporting_questions:
  - "Is offline media the same as synced account data?"
  - "Why should app-managed media not be moved manually?"
audience:
  - "People trying to understand offline media storage"
  - "Users comparing app and operating-system storage reports"
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
excerpt: "Eligible offline media is device-local and app-managed, while progress and preferences are separate account data that may sync across supported devices."
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
  - "/blog/app-data-vs-offline-media-storage/"
  - "/blog/encrypted-local-media-vs-cloud-sync/"
cta:
  label: "Review Norva's Privacy Information"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "storage-layer location map"
  summary: "A location map separates app-managed offline media, synchronized account state, temporary data, application settings, and unrelated device storage."
  methodology: "Readers identify each layer by its purpose and supported control rather than trying to browse or move protected application files."
  asset_urls: []
---

# Why the Offline Download Location Matters

> **In short:** Eligible Norva offline media is encrypted and stored on the device, while progress, history, favorites, and preferences are separate account data that can sync across supported devices. The local copy belongs to the app-managed storage layer, not an ordinary folder or cloud backup. Manage it through the app, verify it on each device, and do not move protected files manually.

Knowing where an offline item lives prevents three common assumptions: that it will appear on every signed-in device, that it can be copied like a normal file, or that clearing any storage category removes only media.

## Separate local media from account state

Norva's privacy policy describes eligible offline media as encrypted and stored on the device rather than uploaded to Norva. That local copy supports playback without a connection when the exact device, compatible source, media, and associated rights allow it.

Progress, history, favorites, and preferences belong to another layer. They can sync across supported devices, but that does not make the media copy cloud-hosted or transferable. The guide to [where offline downloads live](/blog/where-offline-downloads-live/) explores this distinction in more detail.

## Understand app-managed storage

Modern operating systems generally isolate application data. Their storage settings may show an app total, documents and data, cache, or other categories, but the labels and accounting rules differ by platform and version.

Norva's total can therefore include more than completed offline media. The [app data versus offline media guide](/blog/app-data-vs-offline-media-storage/) separates:

- application code;
- account and preference state;
- catalogue metadata and artwork;
- temporary or cached data;
- completed encrypted offline media;
- incomplete activity that may require investigation.

Do not expect the sum of visible items to match the operating-system total exactly.

## Why manual file movement is unsafe

An app-managed encrypted item depends on more than raw media bytes. The app may need its records, version context, selected tracks, current eligibility, and associated rights. Moving, renaming, exporting, or editing protected files can break that relationship and is not a supported storage-management method.

Use item-level app controls for removal. Use current platform settings to inspect the broader footprint. If the two views disagree, record the difference and investigate rather than opening internal folders.

## Verify the location through behavior

You do not need access to an internal path to prove that an item is local. Use an operational test:

1. confirm the exact item, profile, version, audio, and subtitles;
2. confirm preparation completed;
3. record current device and app storage views;
4. disable connectivity;
5. sample more than one playback position;
6. repeat the check on another signed-in device.

If only the prepared device plays the item offline while progress remains visible elsewhere after synchronization, the observations match the two-layer model. Do not generalize from one test to every item or platform.

## Know which actions affect the local copy

Removing the item through the app should target that local item. Broader actions can have broader consequences. Norva's privacy policy says downloaded media is removed when the app is uninstalled. Platform actions such as offloading, deleting an app, clearing cache, or clearing storage vary; read the exact current wording before proceeding.

The comparison of [encrypted local media and cloud sync](/blog/encrypted-local-media-vs-cloud-sync/) helps choose the correct backup, migration, and cleanup expectation for each layer.

## Original evidence: storage-layer location map

| Layer | Example | Where observed | Can it sync? | Safe control | Verification |
| --- | --- | --- | --- | --- | --- |
| Offline media | Eligible prepared item | App offline area and device storage | Do not assume | In-app item control | Disconnected playback |
| Account state | Progress or favorite | Signed-in supported devices | May sync | Account/app setting | Compare after reconnection |
| Temporary data | Cache or transfer residue | Platform-dependent storage view | No assumption | Current platform guidance | Before-and-after reading |
| Other device data | Photos, maps, messages | Device storage settings | Platform-dependent | Owning app or system control | Category recheck |

Fill this map with observed labels from the target device. It documents what is known without claiming access to the app's internal storage path.

## Common mistakes and limitations

- Calling device-local media a cloud copy.
- Assuming sign-in reproduces offline media on another device.
- Looking for an ordinary exportable file.
- Treating all app storage as completed media.
- Moving or deleting protected internal files manually.
- Assuming uninstall preserves prepared items.
- Using one platform's storage labels on another.

## Frequently asked questions

### Can I choose an ordinary folder for offline media?

Do not assume so. Norva describes eligible items as encrypted and stored on the device. Use the controls exposed by the current app rather than manipulating storage paths.

### Does cloud sync back up the media itself?

No such conclusion follows. Norva distinguishes synced progress and preferences from device-local encrypted offline media.

### Why does the device show more app storage than my items suggest?

The total may include app code, settings, metadata, cache, temporary activity, and media. Category definitions and refresh timing also vary.

## Your next step

[Review Norva's privacy information](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up storage](https://support.google.com/android/answer/7431795?hl=en)
