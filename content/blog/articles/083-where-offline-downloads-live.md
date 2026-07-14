---
content_id: "NVB-083"
title: "Where Offline Downloads Live and What Stays in the Cloud"
seo_title: "Offline Downloads: Device vs. Cloud"
meta_description: "Understand the boundary between encrypted offline media stored on a device and account information that can sync through the cloud."
slug: "where-offline-downloads-live"
canonical_url: "https://norva.tv/blog/where-offline-downloads-live/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "educational-explainer"
topic_cluster: "Offline & Mobile Viewing"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Where are Norva offline downloads stored, and what information stays in the cloud?"
supporting_questions:
  - "Are offline media files uploaded to Norva?"
  - "Why can progress still sync across devices?"
audience:
  - "Privacy-conscious Norva users"
  - "Mobile users managing offline storage"
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
excerpt: "Norva stores eligible offline media encrypted on the device rather than uploading it to Norva, while separate account state can sync across supported devices."
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
parent_pillar: "/blog/offline-playback-explained/"
related_articles:
  - "/blog/remove-offline-downloads/"
  - "/blog/playback-progress-sync-explained/"
  - "/blog/cross-device-media-player-data/"
cta:
  label: "Read Norva's Privacy Policy"
  href: "https://norva.tv/privacy"
  intent: "consideration"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/#features"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "device-cloud data boundary map"
  summary: "A classification worksheet separates local media, account state, source data, and temporary device data."
  methodology: "Readers classify observable items by location and purpose, then verify each conclusion against the current privacy policy and device storage view."
  asset_urls: []
---

# Where Offline Downloads Live and What Stays in the Cloud

> **In short:** Norva states that eligible offline media items are encrypted and stored on the device; those media items are not uploaded to Norva. Separate account information, including progress, history, favourites, and preferences, can sync across supported devices. Local media storage and cloud account state serve different purposes.

The word “download” can hide several kinds of data. A playable local media copy is not the same as a thumbnail cache, a favourite marker, or a progress timestamp. Separating them makes storage cleanup and privacy decisions more precise.

## The local media layer

When offline access is available, the playable media data must be accessible to the device without contacting the source during the session. Norva's privacy information says eligible offline items are encrypted and stored on the device and are not uploaded to Norva.

App-managed storage may not appear as a normal video in a file manager. That is expected for many managed offline workflows. Use the media app's offline controls to open or remove an item rather than moving internal files manually.

Offline availability remains conditional on the device, compatible source, media, and associated rights. Local storage does not change those conditions or transfer ownership.

## The synchronised account layer

Norva can retain account state across supported devices, including:

- playback progress;
- viewing history;
- favourites;
- language and subtitle preferences;
- profile-specific organisation state.

This information is much smaller than a media file and has a different function. It allows the same account to continue a workflow across supported screens. A device needs connectivity before new local changes can be reconciled with another device.

For a focused explanation, see [how playback progress sync works](/blog/playback-progress-sync-explained/).

## The connected-source layer

Norva organises a compatible source that the user owns or is legally authorised to use. The source remains responsible for its catalogue data, availability, and rights model. Artwork, metadata, categories, and available media versions can come from that connected environment rather than being an offline media copy stored by Norva.

Do not confuse a library card that remains visible with proof that the underlying media is available offline. The [offline playback lifecycle](/blog/offline-playback-explained/) starts with item-level eligibility and requires a disconnected test.

## Temporary and operating-system data

The app and operating system may also keep thumbnails, indexes, logs, temporary transfer data, or caches. These can help performance but are not equivalent to a completed offline item.

Storage settings may group categories differently. Apple and Android provide per-app storage views, but names and available controls vary. Avoid clearing all app data simply to remove one offline item. Start with the [item-level removal workflow](/blog/remove-offline-downloads/).

## Encryption claims need precise wording

“Encrypted on device” does not mean every part of the whole service uses end-to-end encryption. Norva separately states that traffic to its cloud is protected in transit with HTTPS. These are two distinct protections:

- local encryption concerns eligible offline items stored on the device;
- HTTPS concerns data travelling between the app or browser and Norva's cloud.

Neither statement supports a claim of absolute security or anonymity. Read the current privacy policy for the categories of data, service providers, purposes, retention, and user controls.

## Original evidence: data boundary map

Use this worksheet for one observed item:

| Data or state | Expected location | How to verify | Removal route |
| --- | --- | --- | --- |
| Eligible offline media | Device, app-managed | Airplane-mode playback test | In-app offline control |
| Playback progress | Account state that can sync | Compare same profile after reconnection | Current account/app controls |
| Favourite marker | Account state that can sync | Compare supported devices | Current app control |
| Source catalogue metadata | Connected source workflow | Refresh while connected | Source-specific controls |
| Thumbnail or cache | Device temporary/app data | Platform storage view | Platform/app guidance |

Mark uncertain rows as “needs verification” rather than guessing. The guide to [data used by a cross-device media player](/blog/cross-device-media-player-data/) can help review broader account data.

## Common mistakes and limitations

- Calling every app file an offline download.
- Assuming a visible poster is playable without connectivity.
- Treating progress sync as cloud storage of the media file.
- Claiming end-to-end encryption from an HTTPS statement.
- Manually moving encrypted app-managed files.
- Expecting local data to survive app deletion or device reset.
- Assuming operating-system storage labels are identical across devices.

Product and platform behaviour can change. Recheck the current privacy policy and device documentation before publication or a sensitive cleanup.

## Frequently asked questions

### Can I find a Norva offline item in my normal photo or video folder?

Do not assume so. Eligible offline items are app-managed and encrypted on the device. Use Norva's offline controls rather than searching for a transferable file.

### Does deleting an offline item delete my source media?

The in-app offline removal action should be treated as removal of the local copy, not an instruction to alter the source. Read the exact confirmation wording before proceeding.

### Why does progress appear on another device if the media stays local?

Playback progress is separate account state. It can sync after the device reconnects without uploading the offline media item itself to Norva.

## Your next step

[Read Norva's privacy policy](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva features](https://norva.tv/#features)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up space](https://support.google.com/android/answer/7431795?hl=en)
