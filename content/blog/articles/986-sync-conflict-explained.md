---
content_id: "NVB-986"
title: "What Is a Sync Conflict in a Media App?"
seo_title: "What Is a Media App Sync Conflict?"
meta_description: "Learn what a media-app sync conflict is, how competing progress, favorite, preference, catalog, or device states arise, and how to preserve evidence."
slug: "sync-conflict-explained"
canonical_url: "https://norva.tv/blog/sync-conflict-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "sync-conflict-concept-guide"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is a synchronization conflict in a media app?"
supporting_questions:
  - "How do competing states arise across profiles, devices, catalogs, and time?"
  - "Which evidence should be preserved before trying to resolve a conflict?"
audience:
  - "Media player users"
  - "Viewers troubleshooting cross-screen state"
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
excerpt: "A sync conflict occurs when competing updates cannot all become the final state without a resolution rule, user choice, or loss of one update."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-player-glossary/"
related_articles:
  - "/blog/media-player-glossary/"
  - "/blog/playback-progress-integrity-audit/"
  - "/blog/favorite-sync-integrity-audit/"
cta:
  label: "Review Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "sync-conflict event timeline"
  summary: "A timeline records the last agreed state, two competing changes, device and network context, observed resolution, affected field, recoverability, and confidence."
  methodology: "The user reconstructs events without creating additional writes, keeps profiles and item versions explicit, and distinguishes a true competing update from a stale or filtered view."
  asset_urls: []
---

# What Is a Sync Conflict in a Media App?

> **In short:** A sync conflict occurs when two or more changes compete for the same final state and the system cannot preserve all of them unchanged. Examples include different playback positions, opposite favorite actions, or metadata edits made before devices see each other's updates. A stale view is not automatically a conflict; reconstruct the timeline first.

Synchronization tries to make state understandable across places or times. Conflict is one possible outcome when updates overlap, arrive out of order, target different identities, or occur while a screen is disconnected.

The [media player glossary](/blog/media-player-glossary/) defines the neighboring progress, favorite, profile, catalog, and device terms.

## A conflict needs competing changes

Suppose screen A saves a position at 20 minutes while screen B, still showing an older state, saves 35 minutes for the same profile and media version. The final system must choose, merge, ask, or keep parallel state. It cannot treat both values as the single current position.

By contrast, screen B merely displaying 20 minutes after A reached 35 may be stale without having written a competing value.

## Identity errors can mimic conflicts

Different profiles, episodes, editions, grouped versions, or accounts can legitimately hold different states. If those identities are hidden or confused, the result may look like a conflict.

Record account, profile, source, work, version, and screen before comparing values. Similar artwork or title text is insufficient evidence.

## Progress conflicts

Playback progress is often represented by a current position plus related completion state. Overlapping sessions can advance, rewind, complete, or restart the same item. A resolution might use recency, greatest progress, session order, explicit choice, or another product-specific rule.

Do not assert which policy Norva uses without current verified documentation. Observe the actual result under controlled conditions.

## Favorite conflicts

Favorites have opposite state transitions: add and remove. If one screen adds while another removes based on an old view, the final state needs a rule. An icon and collection list can also become temporarily inconsistent without a true competing write.

Use the [favorite-sync integrity audit](/blog/favorite-sync-integrity-audit/) to record both visible signals before refreshing.

## Catalog conflicts

Source metadata can change while an organizer has an existing matched or grouped record. A rename, new identifier, corrected hierarchy, or variant change may create ambiguity between preserving user state and recognizing a new item.

Do not delete an apparent duplicate until source identity and version distinctions are verified.

## Offline and delayed updates

A device can make or retain state while disconnected, then submit it after another screen has changed the same field. Network delay can also reorder when changes become visible. The conflict window is therefore about event order, not simply wall-clock display.

Offline availability and state synchronization are distinct capabilities. Do not assume every local action will synchronize in every product or condition.

## Resolution strategies vary

Common system designs include last accepted update, latest timestamp, highest progress, field-specific merge, server authority, client authority, duplicate preservation, or user choice. Each can be reasonable for one field and wrong for another.

A favorite cannot be numerically merged, while separate catalog metadata fields sometimes can. Product behavior must be verified rather than inferred from a generic strategy.

## Preserve the event timeline

Before clearing history or repeating actions, record the last agreed state, each screen's initial view, action, local time and zone, connectivity, resulting local state, and final observed state. Use neutral item and device codes.

The [playback-progress integrity audit](/blog/playback-progress-integrity-audit/) provides a controlled conflict step after normal bidirectional tests pass.

## Recover without adding noise

Confirm identities and filters first. Use the normal supported refresh or reopen behavior once. If an explicit conflict choice appears, read it carefully and record the selected outcome. Avoid alternating actions rapidly between screens.

For a persistent reproducible issue, send a sanitized timeline through official support. Exclude credentials, source addresses, private titles, and full account identifiers.

## Original evidence: conflict timeline

| Event | Screen | Initial state | Action | Connectivity | Resulting local state | Final observed state |
| --- | --- | --- | --- | --- | --- | --- |
| Last agreed state | A and B |  | None |  |  |  |
| Competing change 1 | A |  |  |  |  |  |
| Competing change 2 | B |  |  |  |  |  |
| Reconciliation |  |  | Refresh or reopen |  |  |  |

## Common conflict mistakes

- Calling every stale view a conflict.
- Comparing different profiles or versions.
- Repeating actions before preserving the timeline.
- Assuming one resolution strategy for every field.
- Deleting a possible variant as a duplicate.
- Sharing private viewing or account details in evidence.

## Frequently asked questions

### Is a synchronization delay always a conflict?

No. A conflict requires competing state changes. A delayed screen may simply not have received or displayed the latest accepted state.

### Should the greatest playback position always win?

Not necessarily. A viewer may intentionally rewind or restart. Resolution policy is product- and field-specific.

### Can a conflict be fully prevented?

Good identity, ordering, connectivity, and interface design can reduce conflicts, but overlapping or offline changes may still require a resolution rule.

## Your next step

[Review Norva Support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
