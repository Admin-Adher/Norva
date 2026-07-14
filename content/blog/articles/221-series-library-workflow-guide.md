---
content_id: "NVB-221"
title: "The Complete Workflow Guide for a Personal Series Library"
seo_title: "Complete Personal Series Library Workflow Guide"
meta_description: "Run a personal series library with a hierarchy-first workflow for series identity, seasons, episodes, specials, versions, progress, discovery, and maintenance."
slug: "series-library-workflow-guide"
canonical_url: "https://norva.tv/blog/series-library-workflow-guide/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "pillar-guide"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is a complete workflow for running a personal series library?"
supporting_questions:
  - "How should series, seasons, episodes, specials, and versions relate?"
  - "How can progress and next-episode state remain recoverable?"
audience:
  - "People organizing series from sources they are authorized to access"
  - "Norva evaluators looking for a complete series workflow"
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
  source_of_truth: "https://norva.tv/#how-it-works"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A hierarchy-first operating loop preserves series, season, episode, special, version, and progress context from intake through resumption and maintenance."
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
  - "/blog/resume-series-after-long-break/"
  - "/blog/place-series-specials-clearly/"
  - "/blog/handle-split-seasons/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://www.eidr.org/how-we-work"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "eight-stage series library operating loop"
  summary: "An operating loop connects source scope, series identity, hierarchy, sequence, version readiness, viewing progress, discovery, and exception maintenance with explicit pass conditions."
  methodology: "Readers process one structurally complex series through all eight stages, verify parent-child and progress transitions, and route each failure to the owning layer instead of flattening the hierarchy."
  asset_urls: []
---

# The Complete Workflow Guide for a Personal Series Library

> **In short:** Run a series library from the hierarchy outward: establish authorized source scope, identify the series, preserve season and episode parentage, model specials and split seasons without rewriting core sequence, keep versions distinct, verify progress and next-episode state, make discovery controls hierarchy-aware, and maintain exceptions. Test the workflow with one structurally complex series before scaling it.

A series library differs from a movie library because the next action depends on hierarchy and sequence. “What is this?” must be followed by “where does this episode belong?” and “what comes next for this viewer?”

## Use the eight-stage operating loop

| Stage | Core question | Pass condition |
|---|---|---|
| 1. Scope | Which authorized sources and profile? | Context is explicit |
| 2. Series identity | Which series is this? | Collisions and aliases resolved |
| 3. Hierarchy | Which season and episode parent? | Parent-child links valid |
| 4. Sequence | What is the intended order? | Numbering and exceptions visible |
| 5. Versions | Which episode version is usable? | Source, tracks, and edits distinct |
| 6. Viewing state | What was completed and what is next? | Progress resolves to an episode |
| 7. Discovery | Can the right level be searched and filtered? | Series and episodes remain navigable |
| 8. Maintenance | What is uncertain or changed? | Exception queue has owners |

## Stage 1: establish source and profile scope

List compatible sources the user owns or is authorized to access, active profile, and supported devices. Record what current availability means and whether a source refresh is complete.

Norva is organization and playback software, not a supplied series catalogue. Connected-source coverage and metadata determine what can appear.

## Stage 2: identify the series

Use preferred title, alternate title, original release date, country, creators, and another distinguishing clue. Do not merge unrelated series with the same or translated title.

EIDR's public hierarchy distinguishes series, seasons, episodes, edits, and manifestations. That structure is more than display: it provides stable parentage for episode identity and sequence.

## Stage 3: preserve hierarchy

Every episode should resolve to the appropriate season or directly to the series when the authoritative structure has no season. Keep the original hierarchy facts separate from a source's presentation grouping.

Dublin Core `hasPart` and `isPartOf` relationships illustrate the parent-child link. Use stable identifiers when available; titles alone can collide.

## Stage 4: model sequence and exceptions

Record season number or label, episode number, original distribution or release sequence when known, and any alternative display order. Specials, pilots, and split releases need explicit rules rather than forced numbering.

Use [the specials placement workflow](/blog/place-series-specials-clearly/) and [the split-season mapping guide](/blog/handle-split-seasons/) for those exceptions.

## Stage 5: keep versions distinct

One episode may have several source entries or edits. Record runtime, language tracks, subtitles, source, and current availability per version. Do not combine audio from one version with subtitles from another.

Grouping should help selection while preserving which item will actually play.

## Stage 6: make progress episode-specific

Store viewing state against the exact series, season, episode, and version context. Distinguish completed episode, in-progress episode, next episode, and series-level favorite.

When returning after a break, [the series recovery workflow](/blog/resume-series-after-long-break/) reconstructs the last completed episode and next valid step without exposing later events.

## Stage 7: design hierarchy-aware discovery

Search may begin at series level, while filters may apply to series attributes, season state, episode availability, or track requirements. Labels should state the level.

A “year” filter can refer to series start, season release, or episode date. A “continue” row should resolve to one episode, not an ambiguous series poster.

## Stage 8: maintain the exception queue

Track:

- missing or duplicate episode numbers;
- specials with uncertain placement;
- split-season labels that conflict across sources;
- anthology episodes with unclear continuity;
- unavailable next episode;
- progress tied to the wrong version;
- source refresh or sync uncertainty.

| Exception | Level | Evidence | Viewer impact | Next action | Recheck |
|---|---|---|---|---|---|
|  | Series/season/episode/version |  |  |  |  |

## Run the hierarchy integrity test

Choose one episode and navigate upward to season and series, then forward to the next episode and back to the prior one. Verify titles, numbers, availability, progress, and Back behavior on the intended device.

Norva may retain progress, history, favorites, and preferences across supported devices under the same account, but exact behavior depends on current product state and source data. Test a real hierarchy and supported devices before relying on it.

## Common mistakes and limitations

- Applying movie-franchise logic to episode hierarchy.
- Inventing seasons to match one source's menu.
- Renumbering specials into the main sequence.
- Storing progress only at series level.
- Merging episode versions without track verification.
- Treating every anthology as continuously ordered.

## Frequently asked questions

### Must every series have seasons?

No. Preserve the authoritative structure; some limited or mini-series may link episodes directly without an artificial season.

### Should specials count as regular episodes?

Keep them identifiable as specials and provide a viewing placement without rewriting the regular sequence.

### What is the most important integrity test?

Confirm that a saved state resolves to the correct episode and that the next action follows the intended hierarchy and sequence.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [How Norva Works](https://norva.tv/#how-it-works)
