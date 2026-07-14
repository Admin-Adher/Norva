---
content_id: "NVB-085"
title: "Switching Between Wi-Fi and Mobile Data Without Losing Progress"
seo_title: "Switch Wi-Fi and Mobile Data Safely"
meta_description: "Preserve playback progress when changing networks by creating a clear checkpoint, verifying the new connection, and checking the same profile and version."
slug: "switch-wifi-mobile-data-video"
canonical_url: "https://norva.tv/blog/switch-wifi-mobile-data-video/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Offline & Mobile Viewing"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I switch between Wi-Fi and mobile data without losing playback progress?"
supporting_questions:
  - "Will playback continue seamlessly during a network switch?"
  - "How can I create a reliable progress checkpoint?"
audience:
  - "Mobile viewers moving between networks"
  - "Norva users troubleshooting progress after a handoff"
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
  source_of_truth: "https://norva.tv/#how-it-works"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6
excerpt: "Create a deliberate playback checkpoint before changing networks, then verify connectivity and the same profile, item, and version before resuming."
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
  - "/blog/video-quality-mobile-data-use/"
  - "/blog/playback-progress-not-syncing/"
  - "/blog/offline-vs-connected-playback/"
cta:
  label: "Review Norva's Cross-Device Workflow"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#features"
  - "https://support.apple.com/en-us/109323"
  - "https://support.google.com/pixelphone/answer/7055392?hl=en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "network-handoff checkpoint log"
  summary: "A five-field record isolates the saved position, connection change, profile, item version, and resumed position."
  methodology: "Readers pause at a memorable position, wait for the connected state, switch one network variable, then compare the displayed position before resuming."
  asset_urls: []
---

# Switching Between Wi-Fi and Mobile Data Without Losing Progress

> **In short:** Pause playback and create a visible checkpoint before changing networks. Wait briefly while still connected, note the position, switch only the connection, confirm the new network works, and reopen the same item and version under the same profile. A seamless handoff is not guaranteed, so verify progress before continuing.

Network changes can interrupt the media connection and account-state update at different moments. A safer workflow makes your intended position explicit instead of relying on an invisible automatic handoff.

## Create a checkpoint before switching

While the original connection still works:

1. pause at a clear scene boundary;
2. note the displayed elapsed or remaining time;
3. leave the item paused for a short moment;
4. return to the detail or continue-watching view if practical;
5. confirm the intended account and profile.

Do not seek repeatedly or close the app immediately after pausing. One stable checkpoint is easier to diagnose than several rapid state changes.

Norva can sync playback progress across supported devices, but no universal sync time should be assumed. If progress is already inconsistent, use the [playback-progress troubleshooting guide](/blog/playback-progress-not-syncing/) before changing networks.

## Switch one connection variable

Turn off Wi-Fi and confirm mobile data is available, or connect to the intended Wi-Fi before disabling mobile data. Operating-system controls and connection indicators differ, so verify actual reachability by opening a trusted lightweight page or refreshing account state.

Avoid changing the profile, media version, quality setting, and network at the same time. Each additional variable makes a mismatch harder to explain.

Before allowing mobile playback, review per-app mobile-data permissions and any data-saver setting. The [video quality and mobile data guide](/blog/video-quality-mobile-data-use/) explains how to measure real use without relying on generic estimates.

## Resume from the same context

After the new connection is working:

1. reopen the media player if it disconnected;
2. confirm the same account and profile;
3. select the same title, episode, and version;
4. inspect the displayed progress before pressing play;
5. compare it with your checkpoint;
6. resume only when the position is plausible.

If the displayed position is older, do not immediately play from both states. Return to the device with the desired position, verify it is connected, and create a new clean checkpoint.

## When the switch interrupts playback

An interruption does not by itself mean progress is lost. Separate two questions:

- can the new network reach the source and account services?
- did the intended progress state save and reload?

Test source reachability with another known item only after recording the original state. If every item fails, investigate the connection or source. If playback works but one position is wrong, focus on profile, version, and progress state.

For a journey with unreliable coverage, [offline playback may fit better than connected playback](/blog/offline-vs-connected-playback/), provided the item is eligible and tested in advance.

## Original evidence: network-handoff log

| Field | Before switch | After switch |
| --- | --- | --- |
| Connection type | Wi-Fi / Mobile | Wi-Fi / Mobile |
| Account and profile |  |  |
| Exact item and version |  |  |
| Displayed position |  |  |
| Playback result |  |  |

Add the time of the test and whether another device was active. Repeat once in the reverse direction if needed. The log documents your workflow without claiming that every network or device will switch seamlessly.

## Prevent avoidable mobile-data use

If the switch is accidental:

- disable mobile data for the app using current device controls;
- enable a platform low-data or data-saver mode if it fits your needs;
- prepare eligible items on trusted Wi-Fi;
- stop playback before leaving Wi-Fi coverage;
- check the device's per-app data counter after testing.

Low-data controls can affect apps differently. Verify the current operating-system and app behaviour.

## Common mistakes and limitations

- Closing the app at the exact moment the network disappears.
- Resuming before checking the displayed position.
- Comparing different profiles or media versions.
- Switching network, quality, and account at once.
- Assuming a connection icon proves the source is reachable.
- Treating any brief interruption as lost progress.
- Expecting offline changes to sync without reconnecting.

Network, source, device, and app conditions can all affect the handoff. Preserve a checkpoint when the position matters.

## Frequently asked questions

### Will playback always continue without a pause?

No universal seamless-handoff promise should be made. The connection may interrupt while the app reaches the source again. Preserve and verify progress before continuing.

### Why did an older position appear after the switch?

The prior checkpoint may not have reconciled, or you may be viewing another profile or version. Stop, compare those fields, and let the intended device reconnect.

### Can I prevent mobile data fallback entirely?

Use the operating system's per-app cellular controls where available and verify with its data counter. Menu names and behaviour vary by device.

## Your next step

[Review Norva's cross-device workflow](https://norva.tv/#how-it-works)

## Sources

- [How Norva works](https://norva.tv/#how-it-works)
- [Norva features](https://norva.tv/#features)
- [Apple: View or change cellular data settings](https://support.apple.com/en-us/109323)
- [Google Pixel Help: Reduce and manage mobile data use](https://support.google.com/pixelphone/answer/7055392?hl=en)
