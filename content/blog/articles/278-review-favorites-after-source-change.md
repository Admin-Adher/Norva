---
content_id: "NVB-278"
title: "How to Review Favorites After a Source Change"
seo_title: "Review Favorites After a Media Source Change"
meta_description: "Review favorites after a source change with a before-and-after identity ledger for work, version, availability, tracks, favorite target, progress, owner, and retrieval."
slug: "review-favorites-after-source-change"
canonical_url: "https://norva.tv/blog/review-favorites-after-source-change/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Favorites & Watchlists"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should favorites be reviewed after a source change?"
supporting_questions:
  - "How can work identity survive a source remap?"
  - "Which state should be tested before relinking a favorite?"
audience:
  - "Viewers reconnecting or changing authorized sources"
  - "Norva users protecting favorite identity"
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
excerpt: "A source-transition ledger preserves favorite intent while work identity, versions, tracks, availability, and retrieval are rematched."
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
  - "/blog/handle-unavailable-favorites/"
  - "/blog/favorite-correct-media-version/"
  - "/blog/recover-missing-favorite/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.eidr.org/how-we-work"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "favorite source-transition identity ledger"
  summary: "The ledger compares work, version, source, availability, tracks, favorite target, viewer scope, progress, and retrieval before and after a source change."
  methodology: "Readers preserve the old snapshot, match works by strongest identity, classify version changes, relink one item, test retrieval and state, then proceed in small batches."
  asset_urls: []
---

# How to Review Favorites After a Source Change

> **In short:** Preserve a snapshot before changing the source. Match favorites by stable work identity, not card position or artwork; then compare versions, tracks, availability, owner, and progress. Relink one favorite only after the new authorized version supports its future action, and verify retrieval before processing the rest.

A source change can replace identifiers, regroup variants, or expose different language tracks. The preference may remain valid even when the original source record disappears.

## Build the source-transition ledger

| Field | Before | After | Decision |
|---|---|---|---|
| Work identifier |  |  |  |
| Title/type/release |  |  |  |
| Version/edit/runtime |  |  |  |
| Source and availability |  |  |  |
| Audio/subtitles |  |  |  |
| Favorite target |  |  |  |
| Owner/profile scope |  |  |  |
| Progress/history |  |  |  |
| Reopen result |  |  |  |

Record why the favorite was originally saved.

## Preserve the before state

Capture safe identifiers, exact version attributes, list scope, active filters, and representative screenshots. Do not record credentials or private source URLs. Avoid removing the old source before the intended transition procedure requires it.

## Match the underlying work

Prefer stable identifiers, media type, release context, creator, and series relationships. EIDR’s public hierarchy separates works and versions; DCMI metadata terms distinguish identifiers, formats, languages, and relations. Artwork and localized titles are supporting evidence only.

If identity remains uncertain, mark investigate and do not transfer favorite state.

## Compare the new version

The new source may offer a different edit, runtime, audio, subtitles, or regional release. Apply [the correct-version favorite workflow](/blog/favorite-correct-media-version/) to ensure it still supports the original future action.

A version that lacks required tracks is not an equivalent replacement for that viewer, even when the work title matches.

## Separate unavailability from lost preference

If no match is currently available, preserve the identity and use [the unavailable-favorite tree](/blog/handle-unavailable-favorites/). Keep, investigate, or remove based on future purpose—not simply current source status.

Norva does not supply a media catalogue. Users connect compatible sources they own or are authorized to access; content and track availability depend on those sources.

## Relink one item

1. Select a non-critical favorite with clear identity.
2. Add or select the verified new version.
3. Leave the detail page.
4. Reopen it from favorites.
5. Confirm work, version, tracks, and owner.
6. Check progress and history separately.
7. Compare another supported device if sync matters.

If the original appears missing rather than replaced, use [the recovery map](/blog/recover-missing-favorite/) before adding again.

## Process in batches

Classify items:

- exact work and acceptable version;
- work match, version review required;
- temporarily unavailable;
- no confident work match;
- duplicate-looking after transition.

Handle five to ten at a time, verifying list count and retrieval between batches.

## Set stop conditions before the batch

Pause the transition when a stable identifier conflicts, the expected version lacks a required track, profile ownership is unclear, or a relinked card opens the wrong item. Record the affected work as unresolved and leave neighbouring favorites untouched. A stop condition is more valuable than finishing a numerical batch because it prevents one uncertain mapping rule from being repeated across the rest of the library.

## Close the transition

Count each class, preserve unresolved items, and document any state that did not follow. Remove the old snapshot only after the new favorites and essential progress are verified.

Run one final search using a canonical title, one alternate title, and a stable identifier where exposed. Compare the result with the ledger, then clear every temporary filter. This last pass catches records that migrated correctly but became difficult to retrieve because their display title, source badge, or default grouping changed.

## Common mistakes and limitations

- Matching by card order or poster.
- Assuming all versions are interchangeable.
- Removing the old snapshot too soon.
- Re-adding every missing card immediately.
- Combining source and profile changes in one test.
- Sharing credentials in support evidence.

## Frequently asked questions

### Must every favorite be relinked manually?

Not necessarily; current product behavior may remap some records. Audit the outcome rather than assuming either automatic success or failure.

### Should progress move with a favorite?

Treat them as separate states. Verify each against the exact work and version.

### What if the new source has no equivalent version?

Retain the identity for review or remove it only if the future action ends.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [Norva Support](https://norva.tv/support)
