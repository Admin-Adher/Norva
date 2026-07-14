---
content_id: "NVB-133"
title: "How to Clean a Catalog Without Losing Personal Context"
seo_title: "Clean a Catalog Without Losing Personal Context"
meta_description: "Protect progress, favorites, history, profile preferences, version choices, and household context during catalog cleanup with a dependency map and tests."
slug: "cleanup-without-losing-personal-state"
canonical_url: "https://norva.tv/blog/cleanup-without-losing-personal-state/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I clean a catalogue without losing personal context?"
supporting_questions:
  - "Which personal state should be mapped before cleanup?"
  - "How can state preservation be tested safely?"
audience:
  - "Norva users planning catalogue cleanup"
  - "Households with profiles and viewing history"
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
estimated_reading_minutes: 6
excerpt: "Catalogue records are connected to progress, favourites, history, profiles, preferences, and version choices, so cleanup must test relationships as well as visible titles."
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
parent_pillar: "/blog/catalog-cleanup-master-plan/"
related_articles:
  - "/blog/make-catalog-cleanup-reversible/"
  - "/blog/playback-progress-not-syncing/"
  - "/blog/review-old-version-groups/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.loc.gov/static/programs/digital-preservation/personal-digital-archiving/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "personal context dependency map"
  summary: "A record-to-context map identifies progress, history, favourites, profiles, preferences, and version choices that may depend on catalogue identity."
  methodology: "Readers select representative records, record visible context before a pilot change, refresh supported devices, and compare each relationship before approving a batch."
  asset_urls: []
---

# How to Clean a Catalog Without Losing Personal Context

> **In short:** Treat progress, history, favourites, profile preferences, language choices, and selected versions as relationships to catalogue records—not as decoration around them. Before cleanup, map those relationships for representative items, capture a baseline, pilot one reversible change, and verify the same context after refresh on supported devices. Stop if identity or history no longer resolves as expected.

A title can look correct after a merge or re-import while its personal context points to an older record. The visible catalogue and the household experience must therefore be tested together.

## Define personal context explicitly

Depending on the product and connected source, context may include:

- playback position or completion state;
- continue-watching placement;
- favourites or saved items;
- recent-viewing history;
- profile-specific preferences;
- preferred audio or subtitle language;
- a chosen version within a group;
- manual organisation or hidden state.

Norva is designed to retain catalogue, progress, history, favourites, and preferences across supported devices on the same account. Actual tracks, metadata, and source relationships still depend on the compatible authorised source. Confirm current behaviour through support before a high-risk cleanup.

## Build the personal context dependency map

Select examples that cover completed, partly watched, favourite, multi-version, multilingual, series, and rarely used items. Complete one row per example:

| Record | Profile | Context before | Identity clue | Planned action | Expected after | Result |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

An identity clue could be a stable source reference, series relationship, year, version label, or other supported identifier. Do not use title text alone when several records share it.

This map exposes which cleanup actions require preservation, remapping, or acceptance of a reset.

## Classify the cleanup action

Use three risk classes:

1. **Presentation change:** label, ordering, or category wording changes while record identity remains stable.
2. **Relationship change:** regrouping versions, moving categories, or repairing a parent-child link.
3. **Identity change:** removal and re-import, source migration, replacement, or record recreation.

Identity changes deserve the smallest pilot and longest observation. If the action could remove the only reference to a record, follow [the reversible cleanup guide](/blog/make-catalog-cleanup-reversible/) before proceeding.

## Capture a useful baseline

For each selected example, record the visible state, profile, device, source, version choice, and time. Capture counts for favourites and continue-watching items where supported. Keep screenshots only as evidence of what was visible; structured notes are easier to compare.

Also note exceptions that are already broken. Otherwise, an old problem may be incorrectly attributed to the cleanup.

## Run one controlled pilot

Apply the proposed action to the smallest representative set. Then:

1. let the supported refresh complete;
2. search for the item by more than one route;
3. open the correct version or episode;
4. inspect progress, favourite state, history, and preferences;
5. repeat on a second supported device when relevant;
6. sign out or fully refresh only if the documented workflow requires it;
7. compare every dependency-map row.

If progress is missing, use [the watch-progress recovery checklist](/blog/playback-progress-not-syncing/) before making more changes. For grouped items, complete [the old-version review](/blog/review-old-version-groups/) rather than assuming one copy is disposable.

## Decide what can be preserved

Some context may map automatically when stable identity remains; other context may require a supported correction or may not transfer between distinct source records. Record the observed result, not the desired one.

When preservation is impossible, decide before the batch whether to postpone, keep the old record, accept the loss with informed household agreement, or contact support. Never discover the trade-off after a large deletion.

## Common mistakes and limitations

- Testing only an unwatched item.
- Treating duplicate titles as identical records.
- Checking one profile while changing shared organisation.
- Assuming a poster or title proves identity.
- Clearing old records before refresh and comparison.
- Ignoring language and version preferences.

This method cannot guarantee that independent source systems retain every relationship. It creates evidence for a controlled decision and an early stop.

## Frequently asked questions

### Is a backup enough to protect personal context?

Not necessarily. A media backup may preserve files or metadata without preserving application-specific progress, favourites, or profile relationships. Verify each context type separately.

### Should every item be tested?

Test every item in a very small high-risk batch. For a larger coherent batch, use representative and boundary samples plus reconciled counts, then investigate every exception.

### What if two profiles show different results?

Stop the batch and treat the difference as evidence. Record both profiles, confirm the expected ownership of the state, and resolve the discrepancy before continuing.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Library of Congress: Personal Digital Archiving](https://www.loc.gov/static/programs/digital-preservation/personal-digital-archiving/)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
