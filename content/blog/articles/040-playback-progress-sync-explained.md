---
content_id: "NVB-040"
title: "How Playback Progress Sync Works Across Devices"
seo_title: "How Playback Progress Sync Works"
meta_description: "Understand the viewer-facing playback progress model, what must match across devices, and how to diagnose an unexpected resume point."
slug: "playback-progress-sync-explained"
canonical_url: "https://norva.tv/blog/playback-progress-sync-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "pillar-guide"
topic_cluster: "Cross-Device & TV Experience"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How does playback progress sync allow a viewer to resume across supported devices?"
supporting_questions:
  - "What information must match for a correct resume point?"
  - "Why can progress appear delayed or incorrect?"
audience:
  - "People moving playback between mobile, web, and TV"
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
excerpt: "Playback progress sync connects one account's viewing state across supported screens while source, profile, title version, and connectivity still matter."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/start-mobile-finish-tv/"
  - "/blog/playback-progress-not-syncing/"
  - "/blog/sync-favorites-across-devices/"
cta:
  label: "Explore Norva's Cross-Screen Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#faq"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "viewer-state checkpoint model"
  summary: "A five-checkpoint model separates account, profile, title version, recorded position, and device connectivity."
  methodology: "The model describes observable viewer states without asserting undocumented internal architecture or timing."
  asset_urls: []
---

# How Playback Progress Sync Works Across Devices

> **In short:** Playback progress sync associates a viewing position with your account context so another supported device can offer a resume point for the same media. For the handoff to make sense, the profile, title or episode, selected version, and connected source must align. Connectivity and recent activity can affect when the newest state becomes visible.

The useful promise is simple: stop on one supported screen and continue from the same place on another. The details become clearer when progress is treated as one piece of account state rather than as a property permanently embedded in the media.

## The viewer-facing sync model

Without making assumptions about undocumented internal implementation, the experience can be understood through five checkpoints:

1. **Account:** the supported devices use the same Norva account.
2. **Profile:** the same profile owns the relevant viewing state.
3. **Media identity:** both screens refer to the same title, episode, and intended version.
4. **Recorded position:** playback creates or updates a resume point.
5. **Connectivity:** the devices can exchange the account's current state.

Norva states that progress, history, favourites, and preferences remain available across supported devices. The compatible source still supplies the catalogue and media access.

## Why identity matters as much as time

A timestamp alone is not enough. It must be associated with the correct media identity. Problems can appear when:

- two versions of a title are treated as different records;
- duplicate metadata splits one work;
- the wrong episode is opened;
- another profile has its own progress;
- an unavailable version replaces the one previously used.

Before changing progress, confirm the details page. The [version-grouping guide](/blog/group-multiple-media-versions/) helps distinguish intentional variants from duplicates.

## A practical cross-screen handoff

Use this controlled workflow:

1. On the first supported device, open the intended profile and title.
2. Play long enough to establish an unmistakable scene or episode position.
3. Stop playback normally and return to the title or library.
4. Ensure the device has a working connection.
5. On the second supported device, sign in to the same account and profile.
6. Open the same title and version.
7. Inspect the offered resume point before selecting it.

This is a reproducible user check, not a benchmark. It does not promise a particular sync delay because network state, device state, and current product behaviour must be observed directly.

For a day-to-day example, follow [start on mobile, finish on TV](/blog/start-mobile-finish-tv/).

## What happens when a device is offline

Offline access is conditional on the device, source, and associated rights. A device without a connection cannot be expected to show another screen's newest account state at that moment. When connectivity returns, verify the title and progress before assuming which activity should take precedence.

Avoid making conflicting progress changes on several offline screens. If you do, record which profile, version, and device was used most recently; that information is more useful to support than a vague report that “sync is broken.”

## How Continue Watching uses progress

Continue Watching is a presentation of in-progress state. It can provide a shortcut across screens, but it may also expose sampled titles or unexpected versions.

Use [the Continue Watching cleanup framework](/blog/manage-continue-watching/) to classify entries as active, sampled, completed, or ambiguous. Do not use Favorites as a substitute for progress: it is a separate deliberate save that Norva also synchronises.

## Diagnose a wrong resume point

Check in this order:

1. Same account?
2. Same profile?
3. Same title, episode, and version?
4. Did the first device stop normally?
5. Were both devices able to connect?
6. Did another screen play the same item afterward?
7. Does the source still expose the same record?

Changing only one variable at a time preserves useful evidence. The dedicated [playback progress not syncing guide](/blog/playback-progress-not-syncing/) extends this into a full troubleshooting path.

## The checkpoint record

When a mismatch persists, create this record before contacting support:

| Checkpoint | Device A | Device B |
| --- | --- | --- |
| Account identifier, without password |  |  |
| Profile name |  |  |
| Title, season, episode |  |  |
| Version label |  |  |
| Visible progress |  |  |
| Connection state |  |  |
| Approximate time observed |  |  |

Never include passwords, full payment information, or source credentials. The record is designed to reproduce the context, not expose sensitive access.

## Common mistakes and limitations

- Comparing different profiles.
- Opening another version of the same title.
- Expecting an offline screen to display a newer remote update.
- Scrubbing repeatedly during diagnosis.
- Treating Favorites and progress as the same state.
- Assuming a fixed sync time that Norva does not publicly guarantee.

## Frequently asked questions

### Does playback progress follow the device or the profile?

Norva associates synchronised preferences and viewing state with the account experience. Always compare the same profile because separate profiles are intended to keep personal state distinct.

### Can I resume if the second device uses a different version?

The result can be ambiguous because versions may be separate media records. Confirm the intended version before relying on the resume point.

### Why is progress visible on one screen but not another?

Check account, profile, media identity, and connectivity first. If they match and the problem persists, collect the checkpoint record and contact support.

## Your next step

[Explore Norva's cross-screen features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva FAQ](https://norva.tv/#faq)
