---
content_id: "NVB-422"
title: "Handoff, Mirroring, or Casting: Know Which Workflow You Need"
seo_title: "Handoff vs Mirroring vs Casting for Viewing"
meta_description: "Distinguish handoff, screen mirroring, and remote playback before choosing a viewing workflow, and verify which functions your product and devices actually support."
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Distinguish handoff, screen mirroring, and remote playback before choosing a viewing workflow, and verify which functions your product and devices actually support."
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
  - "/blog/how-to-verify-item-identity-before-moving-between-screens/"
cta:
  label: "Review Norva's Verified Cross-Device Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.w3.org/TR/remote-playback/"
  - "https://www.w3.org/TR/presentation-api/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "workflow selection matrix"
  summary: "A goal-first comparison separates where playback runs, what the target displays, source-device dependence, and the verification needed for three distinct second-screen concepts."
  methodology: "Readers define the intended outcome, compare it to standards-based definitions, and choose only a workflow visibly supported by the current product and devices."
  asset_urls: []
---
# Handoff, Mirroring, or Casting: Know Which Workflow You Need

> **In short:** Use handoff when you want to stop on one supported device and continue independently on another. Use screen mirroring when you need the second display to reproduce the first screen. Use remote playback when the target receives and plays media while the source controls the session. These are distinct concepts, and Norva cross-device continuity does not by itself prove mirroring or casting support.

The word “cast” is often used for several different behaviours. That ambiguity causes setup failures: a user expects an independent target app, but the device is looking for a receiver; or they expect an exact screen copy, but only playback controls move.

## Compare the three workflows

| Workflow | Where the visible experience comes from | Source device after start | Main verification |
| --- | --- | --- | --- |
| Handoff | Norva experience opened independently on the target | Can usually stop participating after state is verified | Account, profile, source, item, version, progress |
| Screen mirroring | A reproduction of the source screen | Remains central to the displayed session | Operating-system and display mirroring support |
| Remote playback | Target playback selected or controlled from a source interface | Often remains a controller | Sender, receiver, media, network, and rights support |

These are conceptual distinctions, not a Norva feature list. This article does not claim that Norva implements screen mirroring, casting, a receiver protocol, or the W3C APIs cited below.

## Choose handoff for continuity

Handoff fits when the goal is “continue this item on the TV” or “move from tablet to web.” Norva states that the same account can preserve catalogue, progress, history, favourites, and preferences across supported devices.

The target still needs its own supported Norva route and access to the compatible media source. Follow the [state-by-state handoff guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) and verify the item independently.

**Choose this when:** you want the target to become the primary screen without reproducing the source display.

## Choose mirroring for an exact screen copy

Screen mirroring generally reproduces the source display on another screen. The source remains important because navigation, notifications, orientation, and other on-screen activity may appear on the target.

Verify mirroring through current official documentation for the tablet, operating system, and display. Consider privacy before exposing notifications or account details.

**Choose this when:** the real requirement is to show the same interface or non-media screen to other viewers, and verified mirroring support exists.

## Choose remote playback for a receiver workflow

The W3C Remote Playback specification describes controlling playback on a remote device, while the Presentation API defines communication with a second presentation display. Implementations and device ecosystems vary.

A receiver workflow needs compatible sender and receiver capabilities. A generic “available on TV” statement is not enough to establish them.

**Choose this when:** the target is designed to receive playback and the current sender, receiver, media, network, source rights, and product documentation all support the route.

## Use goal-first questions

Ask:

1. Must the target run Norva independently?
2. Must the target show the entire source screen?
3. Should the source remain a controller?
4. May private notifications appear on the target?
5. Does the target have access to the same authorised source?
6. Is the required function documented for both devices?
7. Do current plan and source conditions allow the intended use?

If the answers conflict, do not activate random connection icons. Clarify the goal first.

## Original evidence: selection card

| Goal | Handoff | Mirroring | Remote playback |
| --- | --- | --- | --- |
| Continue independently on target | Strong conceptual fit | Poor fit | Possible but different |
| Show exact source screen | Poor fit | Strong conceptual fit | Poor fit |
| Keep source as controller | Not required after transition | Yes | Usually |
| Target needs independent source access | Yes | Not necessarily | Depends on implementation |
| Norva support verified here | Cross-device continuity only | Not claimed | Not claimed |

The final row is critical: a conceptual match does not establish product availability.

## Verify before acting

For handoff, check [the prerequisite list](/blog/what-must-match-before-a-cross-device-handoff-can-work/). For any other workflow, consult current official documentation from Norva and the relevant device makers. Do not rely on an icon shape, an old tutorial, or a function available in another app.

Before moving any session, use [item identity verification](/blog/how-to-verify-item-identity-before-moving-between-screens/) so a successful connection does not open the wrong version.

## Limitations and common mistakes

Terms vary across platforms. Some products combine discovery, control, and display under one label. This article provides a decision framework, not device-specific setup instructions.

Common mistakes include treating handoff as mirroring, assuming every TV app is a receiver, exposing notifications during mirroring, confusing profile count with simultaneous-use permission, and expecting the same audio/subtitle tracks without source verification.

## Frequently asked questions

### Does Norva cross-device sync mean it supports casting?

No. Sync and handoff describe continuity of account state. Casting or receiver support requires separate verified product and device documentation.

### Is mirroring best for video?

Not universally. It may reproduce the entire source screen and keep the source involved. Choose based on the actual goal and supported route.

### Can I use the terms interchangeably?

Avoid doing so. Name the expected source and target behaviour so support and household members understand the workflow.

## Your next step

[Review Norva's verified cross-device features](https://norva.tv/#features)

## Sources

- [W3C Remote Playback API](https://www.w3.org/TR/remote-playback/)
- [W3C Presentation API](https://www.w3.org/TR/presentation-api/)
- [Norva Features](https://norva.tv/#features)

