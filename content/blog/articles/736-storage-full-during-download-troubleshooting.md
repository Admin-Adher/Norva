---
content_id: "NVB-736"
title: "Storage Full During a Download? A Safe Triage"
seo_title: "Storage Full During a Download: Safe Triage"
meta_description: "Triage a storage-full interruption safely by stopping retries, recording the item state, reclaiming targeted space, and verifying one clean retry."
slug: "storage-full-during-download-troubleshooting"
canonical_url: "https://norva.tv/blog/storage-full-during-download-troubleshooting/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-guide"
topic_cluster: "Offline Storage"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should I do when storage becomes full during offline preparation?"
supporting_questions:
  - "How can I reclaim space without losing useful evidence?"
  - "When is it safe to retry the interrupted item?"
audience:
  - "People whose offline preparation stopped for storage reasons"
  - "Travellers needing a safe recovery before departure"
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
excerpt: "A safe storage-full triage preserves the first error, stops repeated attempts, restores a reserve with targeted removal, and verifies one controlled retry."
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
  - "/blog/find-unexpected-offline-storage-use/"
  - "/blog/reclaim-offline-space-without-account-reset/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "storage-full triage timeline"
  summary: "A timeline captures the first interruption, item state, free space, targeted cleanup, refresh delay, retry conditions, and final verification."
  methodology: "Readers stop repeated attempts, preserve the first state, remove one confirmed category through supported controls, and run one measured retry."
  asset_urls: []
---

# Storage Full During a Download? A Safe Triage

> **In short:** Stop repeated retries, preserve the first visible message, and record the affected item, app state, and device free space. Identify completed, incomplete, and unnecessary local items; restore a protected reserve through targeted in-app removal; then wait for storage reporting to refresh. Retry once only after the exact item remains eligible and enough measured space exists, and verify the result without connectivity.

A storage-full interruption is both a capacity problem and a diagnostic event. Repeatedly starting the same transfer can obscure the original state, consume more time, and leave several incomplete attempts without improving readiness.

## Freeze the first useful evidence

Do not dismiss the message until you record its exact wording and time. Note the device, app version, account and profile, compatible source, item and version, selected tracks, connection type, current free space, and whether the app labels the item incomplete, failed, paused, or absent.

Avoid including passwords, tokens, or source credentials in the record.

## Confirm the storage condition

Open the device storage settings and compare current free space with the last known baseline. Then inspect Norva's offline area. Norva states that eligible offline media is encrypted and stored on the device, but the operating-system app total may also include code, settings, cache, metadata, and temporary data.

If the overall growth does not match known preparation activity, use the [unexpected storage diagnostic](/blog/find-unexpected-offline-storage-use/) before deleting anything broadly.

## Stop and classify the affected item

Determine whether the item is:

- fully completed and available offline;
- visibly incomplete or paused;
- failed and awaiting a supported retry;
- no longer eligible under the current conditions;
- duplicated by another planned item or device.

Do not count an incomplete card as usable. If the app exposes a supported remove or cancel control for the affected item, read its confirmation before using it. Do not manipulate encrypted app-managed files directly.

## Restore a working reserve

Start with finished or unnecessary items and remove them through the app. Follow the [reclaim-space-without-reset sequence](/blog/reclaim-offline-space-without-account-reset/): change one item or category, wait for the device report to refresh, and record the new free-space reading.

Preserve the [free-space reserve](/blog/set-free-space-reserve-offline-media/) chosen for the device's ordinary tasks. The retry needs space for the item and should not consume that reserve. Avoid clearing all app data or reinstalling; Norva's privacy policy says uninstalling removes downloaded media.

## Make one controlled retry

Before retrying, confirm:

1. the required item is still eligible on the exact device;
2. the compatible media source is available and authorized;
3. required audio and subtitles are selected;
4. measured free space remains above the reserve after the estimated item size;
5. the connection and power conditions are suitable;
6. no other large storage operation is running.

Run one attempt and watch its state. If it completes, disable connectivity and sample more than one playback position. If the same failure returns, stop and compare the two timeline entries rather than entering a retry loop.

## Escalate with a narrow report

Contact support when the state remains unexplained after targeted cleanup and one controlled retry. Provide the non-sensitive timeline, versions, storage readings, visible message, and exact steps. State what you did not do, such as clearing all app storage, because that helps preserve the diagnostic boundary.

## Original evidence: storage-full triage timeline

| Time | Event or action | Free space | Item state | Reserve protected? | Result |
| --- | --- | --- | --- | --- | --- |
|  | First interruption |  |  | Yes / No | Recorded |
|  | Targeted removal |  |  | Yes / No |  |
|  | Single retry |  |  | Yes / No | Pass / Recheck |
|  | Offline verification |  |  | Yes / No | Pass / Recheck |

Attach a reason for every removal. If the change in storage does not match the expected direction, record it as unexplained and stop expanding the cleanup.

## Common mistakes and limitations

- Retrying repeatedly without checking free space.
- Deleting several categories before measuring any result.
- Counting an incomplete item as ready.
- Clearing all app data as the first response.
- Crossing the reserve to force the item to fit.
- Assuming the same error always has the same cause.
- Sending credentials in a support report.

## Frequently asked questions

### Should I restart the device immediately?

First record the error and item state. A restart may be a later platform-appropriate step, but it should not erase the first evidence.

### How much space is enough for a retry?

Use a measured estimate for a comparable item plus the device-specific reserve. Do not rely on a universal number.

### What if the retry succeeds while connected?

That proves completion only partially. Disable connectivity and verify the exact version and tracks at several playback positions.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up storage](https://support.google.com/android/answer/7431795?hl=en)
