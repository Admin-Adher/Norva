---
content_id: "NVB-224"
title: "How to Organize Split Seasons and Midseason Breaks"
seo_title: "Organize Split Seasons and Midseason Breaks"
meta_description: "Organize split seasons by preserving the parent season and episode sequence while recording release windows, part labels, source groupings, and resume boundaries."
slug: "handle-split-seasons"
canonical_url: "https://norva.tv/blog/handle-split-seasons/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should split seasons and midseason breaks be organized?"
supporting_questions:
  - "When is a part label a presentation group rather than a new season?"
  - "How should episode numbering and resume state cross the break?"
audience:
  - "People organizing series released in multiple parts"
  - "Norva evaluators checking season hierarchy and episode continuity"
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
estimated_reading_minutes: 7
excerpt: "A season-part crosswalk keeps one authoritative season and episode sequence while mapping release blocks and source-specific labels as reversible presentation layers."
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
parent_pillar: "/blog/series-library-workflow-guide/"
related_articles:
  - "/blog/place-series-specials-clearly/"
  - "/blog/resume-series-after-long-break/"
  - "/blog/organize-anthology-series/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.eidr.org/how-we-work"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "season-part hierarchy crosswalk"
  summary: "A crosswalk records canonical series and season, episode sequence, release windows, official and source part labels, break boundary, specials, progress behavior, and confidence."
  methodology: "Readers verify the authoritative season record, preserve episode identifiers, add parts as presentation groups when appropriate, map source labels, and test next-episode behavior across the break."
  asset_urls: []
---

# How to Organize Split Seasons and Midseason Breaks

> **In short:** Keep the authoritative parent season and original episode sequence intact. Represent Part 1, Part 2, or a midseason block as a presentation group when it is not a separately defined season. Record each block's release window, official label, source-specific aliases, boundary episodes, relevant specials, and confidence. Then test that progress advances across the break without resetting or skipping.

A release pause changes how a season is delivered, but it does not automatically create a new season. Source menus may split or renumber the same episodes differently, so the library needs a crosswalk rather than another guessed hierarchy.

## Build the season-part crosswalk

| Field | Canonical season | Part or block A | Part or block B |
|---|---|---|---|
| Series/season identifier |  | Inherits | Inherits |
| Official label |  |  |  |
| Source label |  |  |  |
| Release start/end |  |  |  |
| First/last episode |  |  |  |
| Episode numbering |  |  |  |
| Break boundary |  |  |  |
| Special placement |  |  |  |
| Evidence confidence |  |  |  |

Keep aliases so users can search the label they encountered without making every alias a new season.

This crosswalk also keeps future corrections local: a changed source label can be remapped without renumbering episodes or rewriting completed viewing history.

## Verify the parent season

EIDR's public hierarchy places seasons under series and episodes under seasons. Check whether authoritative metadata creates one season or multiple season records before adding local part groups.

If there is one season, preserve it. A source's “Volume 2” or “Part B” can be mapped as a release block. If authoritative evidence defines separate seasons, represent them separately rather than forcing one season for visual simplicity.

## Preserve episode identifiers

Record original distribution number, title, and stable identifier where available. Do not restart episode numbering at 1 merely because a second block appeared later, unless the authoritative scheme actually does so.

Dublin Core `hasPart` and `isPartOf` relationships support the distinction between a season and its logical parts. A local display group can link to episodes without changing their parent identity.

## Model the break explicitly

Store:

- last episode before the break;
- first episode after it;
- release dates or windows;
- whether a special appeared during the break;
- source labels and aliases;
- next-episode behavior;
- any spoiler-safe transition note.

Use [the specials placement card](/blog/place-series-specials-clearly/) when a special sits near the boundary. Do not absorb it into a part by default.

## Test progress across the boundary

Mark the final episode of the first block complete in a controlled test. Verify that:

1. the next action resolves to the correct episode;
2. season progress does not reset;
3. the second block label is visible but not mistaken for a new series;
4. Back returns to the same season context;
5. source or version selection remains valid.

When resuming after months, [the series recovery workflow](/blog/resume-series-after-long-break/) should identify the break as a context boundary while preserving the last completed episode.

## Handle conflicting source schemes

Create an alias map:

| Source | Displayed season | Displayed part | Episode label | Canonical mapping |
|---|---|---|---|---|
|  |  |  |  |  |

Do not choose a winner merely because one source is currently available. Preserve the authoritative hierarchy and map each source item into it with evidence.

## Keep anthology structure separate

A split release does not determine whether episodes share continuity. Use [the anthology workflow](/blog/organize-anthology-series/) to model independent stories, recurring themes, or seasonal continuity without changing the release-block crosswalk.

Norva may organize series versions and compatible authorized sources, but season and part labels depend on connected metadata. Verify identifiers and sequence before correcting or merging source records.

## Common mistakes and limitations

- Turning every release pause into a new season.
- Restarting episode numbers for a local part.
- Using current source labels as canonical history.
- Hiding specials inside the break.
- Failing to test next-episode behavior.
- Confusing release structure with narrative continuity.

## Frequently asked questions

### Is Part 2 always a new season?

No. Check authoritative season identity and episode parentage; a part can be a release or presentation block.

### Should part labels appear to users?

Yes when they help navigate or match source terminology, but they should not replace canonical season and episode identity.

### What if sources disagree on numbering?

Preserve source aliases and map each item to a verified canonical episode rather than renumbering the library repeatedly.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Features](https://norva.tv/#features)
