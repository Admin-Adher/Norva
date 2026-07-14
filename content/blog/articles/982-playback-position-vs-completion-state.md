---
content_id: "NVB-982"
title: "Playback Position vs. Completion State: What Changes?"
seo_title: "Playback Position vs Completion State"
meta_description: "Learn how playback position differs from completion state, why thresholds and credits matter, how syncing can conflict, and how to test each value separately."
slug: "playback-position-vs-completion-state"
canonical_url: "https://norva.tv/blog/playback-position-vs-completion-state/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "media-state-concept-comparison"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between playback position and completion state?"
supporting_questions:
  - "Why can a title be completed while retaining a non-final position?"
  - "How should position and completion be tested and synchronized separately?"
audience:
  - "Media player users"
  - "Viewers troubleshooting progress state"
author: { name: "", profile_url: "" }
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
estimated_reading_minutes: 7
excerpt: "Playback position is a timeline value; completion is a classification that may use thresholds, duration, credits, explicit actions, or current product rules."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-player-glossary/"
related_articles:
  - "/blog/media-player-glossary/"
  - "/blog/resume-point-vs-bookmark/"
  - "/blog/playback-progress-integrity-audit/"
cta:
  label: "Review Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/support"
  - "https://html.spec.whatwg.org/multipage/media.html"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "playback-state transition table"
  summary: "A six-scenario table separates raw position, duration context, inferred completion, offered resume behavior, user action, and expected audit evidence."
  methodology: "Scenarios are constructed around start, middle, near-end, credits, replay, and explicit state changes without asserting a Norva-specific completion threshold."
  asset_urls: []
---

# Playback Position vs. Completion State: What Changes?

> **In short:** Playback position answers "where on the timeline?" Completion state answers "how should this item be classified?" A player may calculate completion from position, duration, credits, explicit user actions, or product-specific thresholds. The two values can change together, but they should be recorded and tested separately.

Confusing these concepts leads to reports such as "my progress disappeared" when an item was intentionally moved from Continue Watching to a completed state. The underlying position may still exist, may be reset, or may be handled differently by the current product.

The [media player glossary](/blog/media-player-glossary/) places both terms within the wider state model.

## Playback position is a timeline value

In web media, the current playback time is represented on the media timeline. A user can move that value by playing, seeking, or restarting. The player may save a rounded or periodic position rather than every rendered frame.

A displayed progress bar is an approximation. Its visible width can differ from the saved numeric value, especially on a short item or small screen.

## Completion is a classification

Completion typically indicates that the player or user considers the item watched. The classification may use a threshold near the end, known credits, duration, an explicit action, or another rule. The exact rule is product-specific and can change.

Do not invent a Norva percentage threshold. Consult current official guidance and record observed behavior with the tested item and version.

## Why the values can diverge

An item can have a position near the end but remain "in progress" if the completion rule has not been met. It can be marked completed while a technical position remains before the final frame. Replaying a completed item may create a new position without immediately removing its completion classification.

Short clips, live-like media, credits, trailers, and items with unusual duration metadata can make a simple percentage rule unreliable.

## Resume behavior is a third question

The resume point is the position the player offers or uses when the item opens again. It may be derived from the saved position, adjusted to avoid replaying a few seconds, or omitted after completion. This behavior should not be assumed from the completion badge alone.

See [resume point versus bookmark](/blog/resume-point-vs-bookmark/) for another important state boundary.

## Synchronization can affect each state differently

Across supported screens, a position update and completion update may be separate records or events. A stale screen could show the correct completion badge but an old progress bar, or the reverse. Record both before refreshing.

Norva can keep viewing progress across supported devices under the same account, but exact behavior still depends on current implementation, media identity, profile, source, device, and connectivity.

## Test position without reaching completion

Choose a known item and stop at a distinctive middle position. Exit normally, reopen on the same screen, and record the displayed and actual resume points. Then inspect the item's completion classification.

Repeat on a secondary supported screen if continuity matters. Keep account, profile, source, item, and version fixed.

## Test completion without assuming the rule

Use an item whose duration is understood and play through the relevant ending under normal use. Record when the visible classification changes, but do not generalize the observed point. Reopen the item and record whether it restarts, resumes, or offers a choice.

If the interface offers an explicit watched or unwatched control, test it separately from natural playback.

## Audit conflicts separately

The [playback-progress integrity audit](/blog/playback-progress-integrity-audit/) provides a bidirectional ledger. Add completion as its own column rather than interpreting it from the position. Preserve evidence before clearing history or changing versions.

## Original evidence: state-transition table

| Scenario | Position | Duration context | Completion state | Resume behavior | Evidence needed |
| --- | --- | --- | --- | --- | --- |
| Never started | None or start | Known | Not started | Start | Item and profile |
| Mid-playback exit | Middle | Known | In progress | Resume | Displayed and actual time |
| Near end | Late | Known | Product-dependent | Resume or restart | Observed rule only |
| Credits | Late | Credits present | Product-dependent | Product-dependent | Timeline cue |
| Replay completed item | New early position | Known | May remain completed | Product-dependent | Before and after state |
| Explicit state action | Any | Known | User-selected | Product-dependent | Action and verification |

## Common conceptual mistakes

- Treating a progress-bar width as the saved position.
- Assuming one universal completion percentage.
- Inferring resume behavior from a completion badge.
- Comparing different profiles or media versions.
- Refreshing before recording conflicting states.
- Clearing history before preserving evidence.

## Frequently asked questions

### Is 100 percent playback required for completion?

Not necessarily. Completion rules are product-specific and may account for credits, duration, thresholds, or explicit actions. Verify current behavior rather than assuming.

### Can a completed item retain a playback position?

It can, depending on the state model. Position, completion, and resume behavior should be inspected separately.

### Why might two screens show different states?

They may have stale views, different profiles or versions, or independently updated state. Record all identities and both position and completion before troubleshooting.

## Your next step

[Review Norva Support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [Norva support](https://norva.tv/support)
- [WHATWG HTML media elements](https://html.spec.whatwg.org/multipage/media.html)
