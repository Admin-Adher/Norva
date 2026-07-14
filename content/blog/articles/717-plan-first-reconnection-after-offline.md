---
content_id: "NVB-717"
title: "Plan the First Reconnection After an Offline Period"
seo_title: "Plan Your First Reconnection After Offline Use"
meta_description: "Reconnect after offline viewing in a controlled order: trusted network, correct profile, one device, progress verification, conflict review, and cleanup."
slug: "plan-first-reconnection-after-offline"
canonical_url: "https://norva.tv/blog/plan-first-reconnection-after-offline/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Offline Planning"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I prepare for sync after offline viewing?"
supporting_questions:
  - "Which device should reconnect first?"
  - "How should conflicting playback positions be handled?"
audience:
  - "Existing users returning from a disconnected period"
  - "Households that used several devices offline"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6
excerpt: "A controlled first reconnection uses a trusted network, keeps the intended profile active, verifies one device's progress, and resolves conflicts before new playback."
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
parent_pillar: "/blog/offline-viewing-planning-handbook/"
related_articles:
  - "/blog/playback-progress-sync-explained/"
  - "/blog/offline-progress-returns-later/"
  - "/blog/record-offline-library-before-device-change/"
cta:
  label: "Understand Norva Progress Sync"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "first-reconnection sequence log"
  summary: "A log records device order, account and profile, pre-reconnection progress, observed synced state, conflict decision, and cleanup."
  methodology: "Readers reconnect one device at a time and observe state before opening the same item elsewhere, avoiding invented assumptions about conflict resolution."
  asset_urls: []
---

# Plan the First Reconnection After an Offline Period

> **In short:** Reconnect the device holding the intended latest progress first, using a trusted network and the same account and profile. Record the local position beforehand, allow the app to connect, and observe the resulting state before opening that item elsewhere. If several devices changed the same item offline, decide which position matters before continuing playback or cleanup.

Reconnection is not just turning Wi-Fi back on. It is the boundary where local activity can meet account state from other supported devices. A controlled order makes unexpected progress easier to interpret.

## Record the offline endpoint

Before reconnecting, note:

- device used;
- account and profile;
- exact title, episode, and version;
- approximate stopping point or completion state;
- whether another device used the same item;
- offline items that can be reviewed after sync.

Do not create false precision if the position is uncertain. A screenshot or written chapter/scene description can be more useful than an invented timestamp.

The [playback progress sync explainer](/blog/playback-progress-sync-explained/) describes the difference between local playback state and account-level continuity.

## Choose the first device deliberately

Reconnect the device whose progress you intend to preserve. Keep the same Norva account and profile active. Use a trusted connection, open the app, and give it time to establish a normal connected state before touching the same item on another screen.

Norva can sync playback progress, history, favourites, and preferences across supported devices. That capability does not justify assuming how every conflict between two disconnected states will resolve.

## Observe before continuing

After connection:

1. check that the correct account and profile remain active;
2. reopen the item detail without immediately seeking;
3. compare the displayed position with the recorded offline endpoint;
4. wait briefly and refresh only through normal app controls if needed;
5. record the observed result;
6. then inspect another supported device.

If progress appears to move backwards or returns later, the guide to [offline progress after reconnection](/blog/offline-progress-returns-later/) helps document timing without guessing at the cause.

## Handle conflicts as a user decision

When two devices changed the same item offline, choose the meaningful state before playing again. Ask which session occurred last in real life and which profile was used. Avoid repeatedly opening and seeking on both devices, because that creates more state changes while the original conflict remains unclear.

If the app presents no safe way to resolve the result, collect the evidence and contact Norva support. Include device, app version, profile, item, approximate positions, connection order, and timestamps. Do not include passwords or source credentials.

## Reconcile the offline batch

Once progress is stable, review finished local items. Remove only through the app's own controls and only after shared-device owners confirm. Keep any item still needed for another planned gap, but assign a review date.

If a device change follows the offline period, first use the [offline library recording workflow](/blog/record-offline-library-before-device-change/) because local copies should not be assumed to transfer.

## Original evidence: reconnection log

| Step | Evidence | Result |
| --- | --- | --- |
| Offline endpoint recorded | Item, profile, position | Complete / Recheck |
| First device chosen | Reason documented | Complete / Recheck |
| Trusted connection established | Network identified | Pass / Recheck |
| Resulting progress observed | Before and after compared | Expected / Conflict |
| Second device checked later | State recorded | Expected / Conflict |
| Cleanup reviewed | Items retained or removed | Complete / Pending |

The log documents what happened without claiming a universal synchronisation order.

## Common mistakes and limitations

- Reconnecting several changed devices simultaneously.
- Opening and seeking immediately on another screen.
- Using the wrong profile during the first check.
- Assuming the highest timestamp is always the intended state.
- Removing local items before verifying progress.
- Repeatedly refreshing without recording observations.
- Sending credentials in a support report.

## Frequently asked questions

### How long should sync take?

There is no verified universal time. Confirm a normal connection, wait without creating new state, and document whether the result changes.

### Which device should reconnect first?

Use the device holding the progress you intend to keep, unless official support instructions for the current issue say otherwise.

### Can I delete the local copy immediately?

Wait until progress and household needs are verified. Then use the app's local removal control.

## Your next step

[Understand Norva progress sync](https://norva.tv/#how-it-works)

## Sources

- [Norva features](https://norva.tv/#features)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
