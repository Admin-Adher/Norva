---
content_id: "NVB-287"
title: "Why Offline Progress Can Reappear After Reconnection"
seo_title: "Why Offline Progress Can Return After Reconnection"
meta_description: "Understand why progress observed offline may appear after reconnection, and compare a timestamped offline checkpoint with the connected state without creating conflicting tests."
slug: "offline-progress-returns-later"
canonical_url: "https://norva.tv/blog/offline-progress-returns-later/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "educational troubleshooting guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Why can offline progress appear in Continue Watching after reconnection?"
supporting_questions:
  - "How should offline and connected checkpoints be compared?"
  - "How can conflicting playback events be avoided during diagnosis?"
audience:
  - "Viewers using authorised offline access"
  - "Norva users comparing progress after reconnection"
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
excerpt: "An event-timeline method for comparing an offline viewing checkpoint with the state observed after the device reconnects."
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
parent_pillar: "/blog/continue-watching-hygiene-guide/"
related_articles:
  - "/blog/resume-row-differs-between-screens/"
  - "/blog/use-completion-checkpoints/"
  - "/blog/document-resume-row-issue/"
cta:
  label: "Read Norva's Privacy Policy"
  href: "https://norva.tv/privacy"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc3339"
  - "https://developer.android.com/training/data-storage/app-specific"
  - "https://norva.tv/privacy"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "offline-to-connected event timeline"
  summary: "A seven-event timeline records connectivity state, exact media identity, profile, offline checkpoint, reconnection time, first refreshed observation, and final comparison."
  methodology: "Readers test one authorised offline item on one supported device, avoid parallel playback, timestamp each event, reconnect once, and observe before taking corrective action."
  asset_urls: []
---

# Why Offline Progress Can Reappear After Reconnection

> **In short:** Playback performed while disconnected can create a local observation that is not immediately visible elsewhere. After reconnection, the current product may reconcile that state, making an older-looking entry appear or change. To understand the sequence, timestamp the offline checkpoint, reconnect once, avoid parallel playback, and compare the first connected observation before changing anything.

An entry that “comes back” after a device reconnects may feel random, but the useful question is chronological: what did the device know offline, what was visible elsewhere, and what appeared after communication resumed?

## Separate local state from connected observation

Norva’s privacy information says eligible offline items are encrypted and stored on the device rather than uploaded as media to Norva. Offline access remains conditional on the device, compatible source, media, and associated rights. This does not by itself define progress reconciliation, so exact behavior must be verified in the current build.

The safe mental model is modest: a disconnected device can display or record some state locally; a connected account can show state from supported screens; reconnection creates an opportunity for those observations to meet. Do not infer the internal conflict rule.

## Build the event timeline

Use RFC 3339-style timestamps with local offsets and capture these seven events:

| Event | Record |
|---|---|
| 1 | Last connected row state |
| 2 | Device enters offline condition |
| 3 | Exact authorised item and profile opened |
| 4 | Offline stopping checkpoint |
| 5 | State visible before reconnection |
| 6 | Reconnection time |
| 7 | First refreshed row state |

Do not record credentials or expose unrelated history. A text note is often safer than a full-screen photograph.

Use [completion checkpoints](/blog/use-completion-checkpoints/) to describe the intended stopping point consistently. The checkpoint is the viewer’s evidence, not a guarantee of what the application will mark.

## Avoid creating a conflict during the test

Do not play the same title on a second screen while the first is offline. Do not switch profiles, open another version, or repeatedly reconnect. Those actions add competing events and make the timeline difficult to interpret.

Choose one non-sensitive item you are authorised to access offline. Confirm its identity and version before disconnecting. After the offline session, close playback normally, capture the row, reconnect once, and wait only long enough to make one deliberate refreshed observation according to the current interface.

Android documentation explains that app-specific files can live in storage locations managed for the application, but platform storage guidance does not establish Norva’s progress rules. It is a primary reference for the local-storage concept only.

## Compare without labelling the result a loss

Three outcomes are possible to observe:

- the connected row matches the offline checkpoint;
- the row temporarily shows the earlier connected state;
- the row presents another checkpoint that needs identity and profile review.

If screens disagree, follow [the controlled cross-screen comparison](/blog/resume-row-differs-between-screens/). Preserve both observations before replaying. A difference is evidence of inconsistent display at two times, not proof that progress has been permanently deleted.

When the unexpected state persists after one clean reconnection, prepare [a support-ready resume report](/blog/document-resume-row-issue/) with the seven-event timeline, device category, visible product version when available, and expected versus observed result.

## Original evidence: offline-to-connected timeline

The seven-event table is a reproducible evidence asset. Test it once with a harmless item and ask another reviewer to reconstruct the order without oral explanation. If they cannot tell which observation happened offline and which followed reconnection, revise the labels.

The timeline can establish sequence and context. It cannot reveal internal storage architecture, choose the correct checkpoint, or prove a universal sync interval.

## Common mistakes and limitations

- Playing the same item on two screens during the test.
- Forgetting to record the active profile and exact version.
- Treating “offline item stored locally” as proof of a particular progress algorithm.
- Reconnecting repeatedly before capturing the first state.
- Assuming the latest-looking percentage belongs to the latest event.
- Sharing account or source secrets in a support attachment.

Offline availability can change with device, source, media, and rights. Do not build a diagnostic around an item that is not currently eligible.

## Frequently asked questions

### Does reconnection always upload offline progress?

Do not assume a universal rule. Verify the current product and describe only the state you observed before and after reconnection.

### Which checkpoint should win if two devices were used?

This guide does not prescribe an internal conflict policy. Preserve both timelines and contact support if the resulting state is not understandable.

### Should I clear the returned card?

Not until exact identity, profile, and intended progress are confirmed. Clearing it may remove useful evidence.

## Your next step

[Read Norva's Privacy Policy](https://norva.tv/privacy)

## Sources

- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [Android Developers: App-Specific Storage](https://developer.android.com/training/data-storage/app-specific)
- [Norva Privacy Policy](https://norva.tv/privacy)
