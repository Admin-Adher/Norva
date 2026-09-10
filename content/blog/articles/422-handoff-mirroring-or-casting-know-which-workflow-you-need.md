---
content_id: "NVB-422"
title: "Handoff, Mirroring, or Casting: Know Which Workflow You Need"
seo_title: "Handoff vs Screen Mirroring vs Casting: Which to Use"
meta_description: "Choose handoff for independent viewing, mirroring for a screen copy, or casting for receiver playback. Compare controls, privacy, access, and device checks."
slug: "handoff-mirroring-or-casting-know-which-workflow-you-need"
canonical_url: "https://norva.tv/blog/handoff-mirroring-or-casting-know-which-workflow-you-need/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "decision-guide"
topic_cluster: "Cross-Device Handoff"
search_intent: "handoff vs mirroring vs casting"
funnel_stage: "consideration"
primary_question: "Should I use handoff, screen mirroring, or casting for my viewing goal?"
supporting_questions:
  - "How do these workflows differ?"
  - "Does cross-device continuity prove receiver support?"
audience:
  - "People choosing a second-screen viewing workflow"
  - "Norva users avoiding unsupported connection assumptions"
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
updated_at: "2026-09-10T20:52:12Z"
last_fact_check: "2026-09-10"
estimated_reading_minutes: 7
excerpt: "Decide whether you need an independent app, a copy of your screen, or receiver playback controlled from your phone, then check the requirements of that route."
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
  - "/blog/separate-profiles-or-one-shared-profile-a-decision-framework/"
  - "/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/"
cta:
  label: "Review Norva's Cross-Device Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://developers.google.com/cast/docs/overview"
  - "https://support.google.com/chromecast/answer/3228332?hl=en"
  - "https://www.w3.org/TR/remote-playback/"
  - "https://www.w3.org/TR/presentation-api/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "illustrative workflow selection matrix"
  summary: "Three completed fictional scenarios separate independent viewing, a shared screen, and receiver playback, with a choice and an unresolved device or source check for each."
  methodology: "An authored comparison applies documented workflow definitions to stated viewing goals. It is a decision aid, not a device test or a claim that each route was exercised in Norva."
  asset_urls: []
---
# Handoff, Mirroring, or Casting: Know Which Workflow You Need

> **In short:** Use handoff to continue independently in the target device's app. Use screen mirroring to reproduce your screen on another display. Use receiver-style casting to select media on one device and control playback on another. Choose by the behaviour you need, then check the app, receiver, network, and source requirements; the word “cast” alone does not identify the route.

“Show this on the TV” can mean three different things: move your viewing progress, copy your current interface, or use your phone as a remote. A successful connection can still be the wrong workflow if it does not do the thing you expected.

Here, **source device** means the phone or computer you start from; **media source** means the service or files supplying your authorised media. They are not interchangeable.

## Compare the three workflows

| Workflow | Where the visible experience comes from | Source device after start | Main verification |
| --- | --- | --- | --- |
| Handoff | The target's independently opened app | Not needed to render the target's session | Account, profile, source, item, version, progress |
| Screen mirroring | A reproduction of the shared source screen | Continues supplying the displayed screen | Operating-system and display support; what is shared |
| Receiver-style casting | Media played by a receiver, selected from a sender | Provides session controls; continued dependence varies | Sender, receiver, media, network, and rights support |

These are practical categories, not rigid protocol names. Google documents both [casting a Chrome tab or screen](https://support.google.com/chromecast/answer/3228332?hl=en) and [sender-controlled receiver playback](https://developers.google.com/cast/docs/overview). This guide uses “receiver-style casting” for the latter so you can distinguish the intended behaviour before following setup instructions.

## Choose handoff for continuity

Handoff fits when the goal is “finish this item in the TV app” or “move from tablet to web.” Norva's [public feature page](https://norva.tv/#features) describes progress, favourites, history, and profile preferences following you across supported screens. That is continuity of viewing context, not a copy of the first screen.

The target still needs its own supported Norva route and access to the compatible media source. Pause the first session, confirm the intended profile and item version on the target, then verify the resume position before playing. The [state-by-state handoff guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) covers that sequence. A matching poster alone is not enough to identify the same episode or edition.

**Choose this when:** you want the target to become the primary screen without reproducing the source display.

## Choose mirroring for an exact screen copy

Screen mirroring reproduces a shared display rather than opening an independent copy of the target app. Full-screen sharing may reveal navigation, notifications, account details, or other on-screen activity. Sharing a tab or a single app is a narrower scope where the platform offers it; do not assume those modes expose the same things.

Check the sharing scope before starting and close private material that could appear within it. Verify both picture and sound: Google's Chrome instructions distinguish tab casting from full-screen casting and note that screen-cast audio may remain on the computer. A visible picture is not proof that sound has moved too.

**Choose this when:** the real requirement is to show the same interface or non-media screen to other viewers, and verified mirroring support exists.

## Choose remote playback for a receiver workflow

In Google's Cast model, a sender starts and controls the session while a receiver handles media playback. The receiver is not simply a second copy of everything on the phone screen. Whether the session survives closing the sender or losing its connection depends on the actual implementation; check rather than assuming phone independence.

A receiver workflow needs compatible sender and receiver capabilities. Norva's public home page lists **Google Cast**, separately from its Android TV app and cross-screen continuity. That published availability is not a test of your particular receiver, media format, subtitle track, or network. This article does not report a completed Norva casting test.

The [W3C Remote Playback API draft](https://www.w3.org/TR/remote-playback/) describes a broader family of remote playback mechanisms, including cases where the source still renders or relays media. The [Presentation API draft](https://www.w3.org/TR/presentation-api/) concerns presenting web content on another display. Neither specification proves that an app implements a particular API or that every receiver is compatible.

**Choose this when:** the target is designed to receive playback and the current sender, receiver, media, network, source rights, and product documentation all support the route.

## Use goal-first questions

Ask:

1. Do I want the target to run its own app after the transition?
2. Do I need to share the entire screen, just one app, or only the media?
3. Do I want to keep controlling playback from the source device?
4. What private information is inside the chosen sharing scope?
5. Can the selected route access the authorised media source?
6. Is that function documented for these devices and app versions?
7. Do current software-plan and media-source conditions permit the intended use?

If the answers conflict, do not activate random connection icons. Clarify the goal first.

## Original evidence: selection card

The following completed card is an **authored illustration**, not a record of product tests. The people, title, and pause position are fictional. Each choice follows the stated goal; the last column is work still to do, not a successful check.

| Stated situation | Selected workflow | Why it fits | Check before using it |
| --- | --- | --- | --- |
| Maya paused the fictional film Harbour Walk at 18:40 on her phone and wants to finish in the TV app using the TV remote | Handoff | The TV should run an independent session with the right saved context | Same profile, authorised source, exact version, and resume position on the supported TV app |
| Jules wants another person to see the filter panel currently open on a laptop | Mirroring or a supported app/window-sharing mode | The interface itself, not just a video, must appear on the display | Exact sharing scope, display support, and absence of private material |
| Sam wants to choose a film on a phone and keep using that phone's playback controls for the living-room receiver | Receiver-style casting | The sender controls receiver playback without sharing the whole phone interface | Supported sender and receiver, reachable media, permitted use, and required audio/subtitle tracks |

The decisions differ even though all three people say “put it on the big screen.” Reuse the four columns with your own situation. If the final check is unknown, the choice is provisional; an attractive feature label does not complete it.

## Verify before acting

For a shared TV, agree on whose progress and preferences should change. The [separate or shared profile decision guide](/blog/separate-profiles-or-one-shared-profile-a-decision-framework/) helps resolve that before playback starts. For a receiver workflow, consult current Norva and device-maker guidance; do not infer support from an icon shape, an old tutorial, or another app.

Check audio and subtitle availability on the destination as well. A successful picture does not prove that every [embedded or separate subtitle track](/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/) reached it. Record the app version, receiver model, chosen item version, and visible result if you need help; do not share source credentials.

## Limitations and common mistakes

Terms vary across platforms. Some products combine discovery, control, and display under one label. This article provides a decision framework, not device-specific setup instructions.

Common mistakes include treating handoff as mirroring, assuming every TV app is a receiver, exposing notifications during mirroring, confusing profile count with simultaneous-use permission, and expecting identical tracks on every route. Norva is media-player software; no content or TV subscription is included. A connection method does not grant media rights or override a source's access conditions.

## Frequently asked questions

### Does Norva cross-device sync mean it supports casting?

Sync alone does not establish casting support. Norva separately lists Google Cast on its public home page. Check the supported sender, receiver, source, and media for the route you intend to use; this guide has not tested that device combination.

### Is mirroring best for video?

Not universally. It may reproduce the entire source screen and keep the source involved. Choose based on the actual goal and supported route.

### Can I use the terms interchangeably?

Avoid doing so. Name the expected source and target behaviour so support and household members understand the workflow.

## Your next step

Choose one row from the selection card, then [review Norva's cross-device features](https://norva.tv/#features) against that goal. Keep the remaining device and source checks explicit before moving a session.

## Sources

- [Google Cast: sender and receiver overview](https://developers.google.com/cast/docs/overview)
- [Google support: cast a Chrome tab or screen to a TV](https://support.google.com/chromecast/answer/3228332?hl=en)
- [W3C Remote Playback API draft](https://www.w3.org/TR/remote-playback/)
- [W3C Presentation API draft](https://www.w3.org/TR/presentation-api/)
- [Norva Features](https://norva.tv/#features)
