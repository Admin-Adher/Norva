---
content_id: "NVB-087"
title: "Download Failed? A Source, Storage, and Network Checklist"
seo_title: "Offline Download Failed: What to Check"
meta_description: "Diagnose a failed offline download by checking item eligibility, source access, storage, network stability, account state, and a clean retry."
slug: "offline-download-failed-checklist"
canonical_url: "https://norva.tv/blog/offline-download-failed-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Offline & Mobile Viewing"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Why did an offline download fail, and what should I check?"
supporting_questions:
  - "How can I distinguish an item problem from a device problem?"
  - "When should I contact support?"
audience:
  - "Norva users with a failed offline item"
  - "Mobile users troubleshooting downloads"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6
excerpt: "A failed download becomes easier to diagnose when you test eligibility, source reachability, free storage, network stability, and account state separately."
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
  - "/blog/storage-for-offline-video/"
  - "/blog/offline-viewing-travel-checklist/"
  - "/blog/remove-offline-downloads/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/support"
  - "https://support.apple.com/en-gb/108429"
  - "https://support.google.com/android/answer/7431795?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "single-variable download diagnostic log"
  summary: "A control-item test and timestamped log identify whether failure follows one media item or the whole device workflow."
  methodology: "Readers preserve the error, test connected source access, compare one known eligible item, change one variable per retry, and record the outcome."
  asset_urls: []
---

# Download Failed? A Source, Storage, and Network Checklist

> **In short:** Preserve the error, then check the exact item's offline eligibility, connected source access, free device storage, network stability, account state, and app status in that order. Test one other known eligible item and change only one condition per retry. This distinguishes an item-specific failure from a broader device or source problem.

A failed transfer is a symptom, not a diagnosis. Repeatedly pressing download can erase useful evidence and create partial data. Start by recording what happened.

## Capture the failure before retrying

Write down:

- exact title, episode, and version;
- displayed error text or code;
- progress percentage or state;
- device and operating-system version;
- app version if visible;
- account and profile;
- connection type;
- time of failure;
- free storage shown by the device.

Do not include passwords, source credentials, recovery codes, or private media addresses in screenshots or support messages.

## Check whether the item is eligible

Offline access in Norva depends on the device, compatible source, exact media, and associated rights. A title may play while connected but still not be available offline.

Reopen the item and verify that the offline control is present for the same version. Compare with one previously successful or otherwise known eligible item. If only one item fails, the item or version is the stronger lead. If every eligible item fails, continue with device, source, and network checks.

The [offline playback explainer](/blog/offline-playback-explained/) describes this eligibility boundary.

## Confirm source and account access

While connected, try to browse or play a known working item from the same authorised source. Confirm the intended account and profile. If the source itself is unavailable, a local download retry cannot solve that upstream problem.

Do not sign out immediately unless access is clearly broken and recovery details are ready. Signing out can add an authentication problem to the original failure. If credentials are involved, follow the [source credential protection workflow](/blog/protect-media-source-credentials/).

## Verify storage with a reserve

Check free storage in the operating-system settings, not only an in-app estimate. A device can report some free space yet still lack enough working room for a transfer and temporary processing.

Remove completed offline items through the app and wait for storage reporting to refresh. Avoid deleting app-managed folders or clearing all app data. Use the [offline storage budget guide](/blog/storage-for-offline-video/) to measure a representative item and keep headroom.

## Stabilise the network

Use a trusted stable connection. Then:

1. pause other large transfers;
2. keep the device reasonably close to the access point;
3. avoid switching between Wi-Fi and mobile data during the retry;
4. keep the app active if the platform restricts background work;
5. connect power if battery-saving behaviour may pause activity;
6. retry one item once.

Do not disable security warnings or connect to an unverified network simply to finish faster.

## Clean up a partial state carefully

If the failed item remains queued or partial, use the app's cancel or remove control. Close and reopen the app, confirm the partial entry is gone, and start one clean retry.

If app-level removal is unavailable, consult the current platform guidance before clearing cache, storage, offloading, archiving, or deleting the app. Those actions have different consequences and can remove all offline data. The [offline item removal guide](/blog/remove-offline-downloads/) explains the escalation order.

## Original evidence: diagnostic log

| Test | Variable changed | Item A result | Control item result | Conclusion |
| --- | --- | --- | --- | --- |
| Initial | None |  |  |  |
| Storage | Space reclaimed |  |  |  |
| Network | Stable trusted network |  |  |  |
| Clean retry | Partial state removed |  |  |  |

Stop when one change resolves the failure. More simultaneous changes reduce the value of the diagnosis.

## When to contact support

Contact Norva support when the problem persists across known eligible items after source, storage, account, and network checks. Provide the non-sensitive record above, exact steps, error text, and approximate time.

For a source-specific access problem, contact that source through its official route. Norva cannot redefine the source's availability or rights.

## Common mistakes and limitations

- Retrying repeatedly without recording the error.
- Assuming connected playback proves offline eligibility.
- Filling storage to the displayed limit.
- Switching networks during the transfer.
- Clearing all app data before testing one control item.
- Sharing credentials in a screenshot.
- Expecting a support agent to change source rights.

Menu names and background-download behaviour vary by device and operating system.

## Frequently asked questions

### Why does the download stop at the same point?

That can suggest an item-specific, storage, or repeatable network issue, but it is not conclusive. Compare one known eligible control item and record the result.

### Should I reinstall the app?

Not first. Reinstallation can remove local items and settings. Preserve evidence, try item-level cleanup, and consult support or platform guidance before broad actions.

### What details are safe to send support?

Send device, app version, item name, error text, time, connection type, and steps. Never send a password, one-time code, recovery code, or secret source address.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [Norva support](https://norva.tv/support)
- [Apple: Check storage on iPhone and iPad](https://support.apple.com/en-gb/108429)
- [Android Help: Free up space](https://support.google.com/android/answer/7431795?hl=en)
