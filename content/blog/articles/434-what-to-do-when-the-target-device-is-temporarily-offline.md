---
content_id: "NVB-434"
title: "What to Do When the Target Device Is Temporarily Offline"
seo_title: "What to Do When a Handoff Target Is Offline"
meta_description: "Preserve a viewing handoff when the target is offline by keeping the source state stable, diagnosing target connectivity, and verifying any eligible local media."
slug: "what-to-do-when-the-target-device-is-temporarily-offline"
canonical_url: "https://norva.tv/blog/what-to-do-when-the-target-device-is-temporarily-offline/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-guide"
topic_cluster: "Cross-Device Handoff"
search_intent: "offline target device handoff"
funnel_stage: "retention"
primary_question: "What should I do when the target device is temporarily offline during a handoff?"
supporting_questions:
  - "Can offline media replace a normal handoff?"
  - "Which state should I preserve while connectivity returns?"
audience:
  - "Viewers whose handoff target lost connectivity"
  - "People planning eligible offline viewing"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Preserve a viewing handoff when the target is offline by keeping the source state stable, diagnosing target connectivity, and verifying any eligible local media."
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
parent_pillar: "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
related_articles:
  - "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
  - "/blog/what-must-match-before-a-cross-device-handoff-can-work/"
  - "/blog/how-to-document-a-cross-device-handoff-failure/"
cta:
  label: "Review Norva's Supported Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "offline-target decision tree"
  summary: "A decision tree separates loss of account or source connectivity from pre-verified eligible local playback and preserves the source session while the target is unresolved."
  methodology: "Readers record source state, classify target connectivity, test only documented network controls, and proceed locally only when the item was already eligible and verified."
  asset_urls: []
---
# What to Do When the Target Device Is Temporarily Offline

> **In short:** Keep the source paused and preserve its profile, item, version, position, audio, and subtitle state. On the target, distinguish a general connectivity problem from unavailable source access. Restore the documented connection before handoff. Use local playback only when that item was already eligible, stored, and tested on the target; offline availability is not an automatic substitute.

A target that cannot reach account or source state cannot complete a normal handoff reliably. Repeatedly opening cards or changing profiles while offline creates more ambiguity.

## Preserve the source session

Pause and record:

- account and profile;
- item or episode;
- version;
- approximate position;
- audio and subtitles;
- source connectivity.

Do not close the only known-good session until the target route is understood. The [cross-device state guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) treats target readiness as the first layer.

## Classify the target symptom

Ask what is actually offline:

- the device has no network;
- the Norva route cannot authenticate;
- the connected source is unreachable;
- only the selected item is unavailable;
- the item has an eligible local state but the app cannot open it.

Record the exact visible message. Do not call every loading state “offline.”

## Restore connectivity through documented controls

Check the device's current network indicator and known network settings. Use a trusted connection and avoid entering account or source credentials into unexpected prompts.

Change one condition at a time. If other authorised apps or official system pages also lack connectivity, the symptom may be device or network level. That observation narrows the condition but does not diagnose the cause.

## Reopen Norva from a stable state

After the target reports connectivity, open the verified Norva route, confirm account and profile, then find the item independently. Match version and progress before resuming.

The [handoff prerequisite checklist](/blog/what-must-match-before-a-cross-device-handoff-can-work/) prevents audio or timeline troubleshooting before source access is restored.

## Handle eligible local media separately

Norva states that offline access is available only when the device, source, and associated rights allow it. Eligible items are encrypted and stored on the device rather than uploaded to Norva.

A local item can support viewing only if it was prepared on the target and tested before connectivity was lost. Do not assume the source device's local item exists on the target, or that a target can create it while offline.

If the local item opens, verify its item, version, position, audio, and subtitle state. Treat its progress as a state to reconcile later, not as proof that account synchronisation occurred offline.

## Decide whether to wait or continue

- **Wait for connectivity:** best when exact progress and version continuity matter.
- **Continue on the source:** keeps the known-good state.
- **Use verified eligible local media:** appropriate only when already prepared and authorised.
- **End the session:** appropriate when privacy, source access, or identity is uncertain.

Do not invent a deadline for choosing. Base the decision on the viewing need and observed state.

## Original evidence: offline-target tree

| Question | Yes action | No action |
| --- | --- | --- |
| Source session preserved? | Continue target checks | Reconstruct source evidence first |
| Device network restored? | Test Norva route | Use documented device/network steps |
| Account/profile available? | Check source access | Reauthenticate safely or stop |
| Same item/version available? | Compare position | Wait or continue on source |
| Eligible local item already tested? | Verify local state | Do not assume offline access |

This tree keeps normal handoff and local playback as distinct workflows.

## When to escalate

If the target repeatedly loses connectivity only within the Norva route, preserve the exact message, device and app versions, time zone, network type, and reproducible steps. Use [the handoff failure report](/blog/how-to-document-a-cross-device-handoff-failure/) without sharing credentials or private source URLs.

## Common mistakes and limitations

Avoid closing the source too early, repeatedly signing in, assuming an offline badge guarantees playback, creating local items after connectivity is gone, and treating profile count as device permission.

Network, source, rights, device storage, and app lifecycle can affect the result. This workflow does not guarantee reconnection time or local eligibility.

## Frequently asked questions

### Can the target resume progress while offline?

Do not assume current account state is available offline. Verify the eligible local item and reconcile progress after connectivity returns.

### Should I switch to a different profile?

No, not as a connectivity fix. Keep the intended profile and diagnose the target state.

### What if only one item is unavailable?

Check its source access, version, and local eligibility. A single-item symptom is different from a device-wide outage.

## Your next step

[Review Norva's supported features](https://norva.tv/#features)

## Sources

- [Norva Features](https://norva.tv/#features)
- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Support](https://norva.tv/support)

