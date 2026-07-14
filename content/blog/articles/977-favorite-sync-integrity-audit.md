---
content_id: "NVB-977"
title: "How to Audit Favorite-Sync Integrity Across Devices"
seo_title: "Audit Favorite Sync Integrity Across Devices"
meta_description: "Audit favorite-sync integrity across devices with controlled add, remove, list, icon, filter, profile, version, timing, and stale-state recovery checks."
slug: "favorite-sync-integrity-audit"
canonical_url: "https://norva.tv/blog/favorite-sync-integrity-audit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "favorite-sync-integrity-audit"
topic_cluster: "Media App Maintenance & Audits"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I audit favorite-sync integrity across supported devices?"
supporting_questions:
  - "How should add, remove, icon, and list states be tested in both directions?"
  - "Which filters, profiles, versions, and stale views can create false results?"
audience:
  - "Norva account administrators"
  - "Multi-device households using Favorites"
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
excerpt: "A favorite-sync audit checks both icon and list state, add and remove directions, fixed identity, neutral filters, and understandable recovery across screens."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-app-maintenance-audit-handbook/"
related_articles:
  - "/blog/media-app-maintenance-audit-handbook/"
  - "/blog/run-first-favorite-sync-check/"
  - "/blog/post-app-update-smoke-check/"
cta:
  label: "Review Norva Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "favorite-state transition ledger"
  summary: "A two-item, bidirectional ledger captures baseline, add, remote observation, remove, reverse observation, icon state, list membership, filters, and recovery."
  methodology: "The auditor fixes account, profile, item identity, grouping state, and screens; tests one action at a time; and records both visible favorite signals before refreshing."
  asset_urls: []
---

# How to Audit Favorite-Sync Integrity Across Devices

> **In short:** Choose two recognizable items and two supported screens under the same Norva account and profile. Reset filters, record the initial icon and Favorites-list state, add item 1 on screen A, inspect B, remove it on B, and inspect A. Repeat with item 2 in the opposite direction. Preserve timestamps and stale-state evidence before refreshing.

Favorite integrity is not proven by one highlighted heart or one list row. The item control and the Favorites collection are separate visible signals, and either can be hidden by profile, source, availability, or grouping context.

Use the [maintenance and audit handbook](/blog/media-app-maintenance-audit-handbook/) to decide when a favorite review is warranted.

## Fix the identities

Record the Norva account shorthand, profile shorthand, authorized source, two screen categories, app or browser surfaces, and two known items. If versions are grouped, note whether the favorite appears to apply to the work or a particular version under the current interface.

Do not use similar titles as substitutes. A wrong-item match can resemble a synchronization problem.

## Establish a neutral baseline

Reset source, availability, and other relevant catalog filters on both screens. Open each item and record the favorite icon, then inspect the Favorites collection and record list membership. If those signals already conflict, stop and preserve the baseline.

The [first favorite-sync check](/blog/run-first-favorite-sync-check/) provides a shorter onboarding trace. This audit adds two items and explicit stale-state recovery.

## Add on screen A

Activate the favorite control once for item 1. Record the action time, resulting icon state, and local list membership. Navigate away normally. Do not press the control repeatedly, because a second activation may reverse the intended state.

On screen B, record what is visible before any manual refresh. Then use only the normal supported navigation or refresh behavior and inspect both signals again.

## Remove on screen B

Remove item 1 once on B. Record time, icon, and list membership. Return to A and repeat the before-and-after observations. A successful add does not prove that removal propagates or that stale state is easy to understand.

Classify each remote observation as present, absent, conflicting, wrong item, filtered, stale but recoverable, or unknown.

## Reverse the direction

For item 2, add on B and inspect A, then remove on A and inspect B. This balances device order and helps reveal a screen-specific presentation or refresh issue. Keep the same account, profile, source, filters, and grouping state.

Do not compare exact synchronization time across trials unless both screens expose reliable timestamps and current official guidance defines the behavior.

## Test a filter trap

With item 2 favorited, apply one known filter that hides it from the current catalog or Favorites view, if the interface supports that filter. Confirm that the item control still reflects the underlying favorite state when reachable. Clear the filter and verify list membership.

The purpose is to distinguish hidden from removed, not to test every filter combination.

## Preserve privacy-safe evidence

Record item codes rather than full private titles. Crop screenshots to the relevant control or row and remove account identifiers, source details, notifications, faces, and location clues. A favorite list can reveal household interests and should be treated as viewing-context data.

If the issue follows an update, pair this result with the [post-update smoke check](/blog/post-app-update-smoke-check/) instead of resetting the entire account.

## Verify recovery and cleanup

For a stale state, count the normal actions required to reach the correct result. After the audit, return both test items to their intended household state and verify that cleanup on both screens. Record cleanup rather than leaving a test favorite behind.

## Original evidence: favorite-state ledger

| Item and step | Action screen | Remote screen | Icon | List | Filter state | Classification |
| --- | --- | --- | --- | --- | --- | --- |
| Item 1 baseline | A and B |  |  |  | Neutral |  |
| Item 1 add | A | B |  |  | Neutral |  |
| Item 1 remove | B | A |  |  | Neutral |  |
| Item 2 add | B | A |  |  | Neutral |  |
| Item 2 filtered |  |  |  |  | Applied |  |
| Item 2 remove | A | B |  |  | Neutral |  |

## Common audit mistakes

- Checking only the icon or only the list.
- Comparing different profiles or item versions.
- Leaving a hiding filter active.
- Activating the favorite control more than once.
- Refreshing before recording stale state.
- Leaving test favorites in the household catalog.

## Frequently asked questions

### Why use two items?

It helps distinguish an item-specific identity or grouping issue from a broader cross-screen state problem.

### What if the icon is active but the list is empty?

Record both states, confirm profile and filters, then use normal navigation or refresh once. Preserve the conflict before changing the favorite.

### Does a favorite guarantee media availability?

No. Favorite state and source availability answer different questions. The media still depends on the connected source, rights, and current conditions.

## Your next step

[Review Norva Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
