---
content_id: "NVB-267"
title: "How Separate Profiles Keep Favorites Personal"
seo_title: "How Separate Profiles Keep Favorites Personal"
meta_description: "Evaluate personal favorite separation with a profile-scope test covering add, remove, retrieval, device sync, shared use, fallback records, and privacy-minimal labels."
slug: "separate-favorites-by-profile"
canonical_url: "https://norva.tv/blog/separate-favorites-by-profile/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Favorites & Watchlists"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How can separate profiles keep favorites personal?"
supporting_questions:
  - "How should profile scope be verified rather than assumed?"
  - "What fallback works when favorite separation is unavailable or unclear?"
audience:
  - "Households where several people save media"
  - "Norva users evaluating favorite scope"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A reversible profile-scope test verifies whether favorite add, remove, retrieval, and sync actions are actually isolated for each viewer."
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
parent_pillar: "/blog/favorites-curation-guide/"
related_articles:
  - "/blog/decide-what-to-favorite/"
  - "/blog/recover-missing-favorite/"
  - "/blog/create-tonight-shortlist/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "consideration"
sources:
  - "https://www.w3.org/WAI/tutorials/forms/labels/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "reversible favorite profile-scope test"
  summary: "The test records viewer context, harmless test item, add visibility, removal effect, device sync, shared behavior, and fallback ledger."
  methodology: "Readers test one non-critical item across two intended contexts, reverse the change, classify account/profile/device/source scope, and avoid relying on unverified separation."
  asset_urls: []
---

# How Separate Profiles Keep Favorites Personal

> **In short:** Separate profiles can keep preference lists personal only when favorite actions are truly scoped to those profiles. Verify with one harmless item: add it in context A, check context B and another device, remove it, and observe the effect. If isolation is unavailable or unclear, use a minimal private ledger or deliberately shared list rather than assuming an avatar creates separation.

Personal favorites improve discovery because one person’s long-term taste does not flood another person’s list. But interface labels, account state, and device state can differ, so profile behavior must be tested in the current product build.

## Build the profile-scope test

| Field | Context A | Context B |
|---|---|---|
| Viewer or profile label |  |  |
| Account and device |  |  |
| Test item identity |  |  |
| Visible before add |  |  |
| Visible after add |  |  |
| Visible after removal |  |  |
| Other-device result |  |  |
| Final restored state |  |  |

Use a non-critical title with no valuable progress or existing favorite state.

## Confirm the context label

W3C label guidance supports controls whose purpose is explicit. The active viewer or profile should be readable before a favorite action. A decorative avatar alone does not establish scope.

Record the label displayed at the time of the add and remove actions. Do not include unnecessary personal details; a household nickname is enough for the test.

## Run the reversible test

1. Verify the test item is not already a favorite in either context.
2. Add it in context A.
3. Leave the detail page and retrieve it from A’s favorites.
4. Switch to context B without changing the account or source.
5. Check whether the item appears.
6. Check A on another supported device if cross-device use matters.
7. Remove the item from A.
8. Confirm both contexts return to their starting state.

Change one factor at a time. If you switch account, device, and source together, the result cannot identify scope.

## Classify the observed scope

- **Profile-specific:** add and removal affect only the confirmed profile across tested devices.
- **Account-wide:** every context under the account sees the same state.
- **Device-local:** state does not follow to another device.
- **Source-dependent:** the favorite attaches to a particular source record.
- **Unknown:** results are delayed, conflicting, or insufficient.

Do not claim Norva currently supports a particular profile model without verification. Current support documentation is the source of truth for product behavior.

## Define personal and shared lists

Personal favorites should use [the admission decision](/blog/decide-what-to-favorite/) for that viewer’s future action. Shared household choices need a clearly named shared scope and consent from participants.

For a one-evening decision, use [the tonight shortlist](/blog/create-tonight-shortlist/) rather than adding every household candidate to each person’s durable favorites.

## Handle a missing item after switching

A favorite absent from context B may prove successful isolation—or a filter, source, or sync issue. Record expected scope before interpreting it. Use [the missing-favorite investigation](/blog/recover-missing-favorite/) if the item also disappears from its intended context.

## Use a fallback when separation is unclear

Keep a small private external record:

- viewer label;
- exact title or identifier;
- future action;
- date added;
- review trigger.

Avoid sensitive viewing commentary. The fallback should solve retrieval, not create a household surveillance log.

## Protect removal scope

Before bulk cleanup, test one removal. Confirm it does not delete another person’s preference, viewing progress, or history. Favorites and watched state should be treated as separate concepts even when the interface displays them together.

Norva may retain favorites across supported devices under the same account. Verify whether that behavior is account-wide or profile-specific in the current build before relying on it.

## Common mistakes and limitations

- Assuming an avatar proves isolation.
- Testing with an important existing favorite.
- Changing several contexts at once.
- Treating expected isolation as a sync failure.
- Keeping excessive personal detail in a fallback list.
- Bulk-removing before testing scope.

## Frequently asked questions

### Can two profiles intentionally share a favorite?

Yes, by saving it in each verified personal context or using a deliberately shared list if supported.

### Does device separation equal profile separation?

No. Device-local state and viewer-specific state are different scopes.

### What if results appear after a delay?

Record timestamps, wait for the normal verified sync window if known, and classify the result unknown until repeatable.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [W3C: Labeling Controls](https://www.w3.org/WAI/tutorials/forms/labels/)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
