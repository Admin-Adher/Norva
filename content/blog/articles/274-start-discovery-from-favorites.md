---
content_id: "NVB-274"
title: "How to Use Favorites as a Starting Point for Discovery"
seo_title: "Use Favorites as a Starting Point for Discovery"
meta_description: "Turn one favorite into a discovery experiment with a seed hypothesis, explicit similarity dimensions, candidate diversity, source checks, and a stop rule."
slug: "start-discovery-from-favorites"
canonical_url: "https://norva.tv/blog/start-discovery-from-favorites/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Favorites & Watchlists"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can favorites be used as a starting point for discovery?"
supporting_questions:
  - "How should similarity dimensions be made explicit?"
  - "How can discovery avoid turning every candidate into a new favorite?"
audience:
  - "Viewers looking for related media without endless browsing"
  - "Norva users working from saved preferences"
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
excerpt: "A seed-to-candidate experiment names what mattered in one favorite, tests diverse recommendations, and saves only candidates with a new future action."
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
  - "/blog/build-themed-favorites-shortlist/"
  - "/blog/decide-what-to-favorite/"
  - "/blog/avoid-favorite-list-inflation/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.w3.org/WAI/tutorials/forms/labels/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "favorite seed-to-candidate discovery experiment"
  summary: "The experiment records seed identity, valued dimensions, excluded dimensions, candidate source, difference, availability, evaluation, save decision, and stop rule."
  methodology: "Readers choose one verified seed, state two similarity hypotheses, request both close and stretch candidates, evaluate a capped set, and admit only items with independent future intent."
  asset_urls: []
---

# How to Use Favorites as a Starting Point for Discovery

> **In short:** Choose one exact favorite and name what you value about it—such as structure, tone, subject, creator, language, or format. Turn those qualities into two testable similarity hypotheses, evaluate a capped set of close and stretch candidates, and stop. A recommendation is evidence for exploration, not a new favorite until it gains its own future action.

Favorites are useful seeds because they carry a known preference or purpose. They become poor discovery tools when “similar” remains undefined and every suggested card is saved automatically.

## Build the seed-to-candidate experiment

| Field | Entry |
|---|---|
| Seed work and version |  |
| Why it is a favorite |  |
| Similarity hypothesis A |  |
| Similarity hypothesis B |  |
| Dimensions to avoid copying |  |
| Candidate cap |  |
| Close candidates |  |
| Stretch candidates |  |
| Current authorized availability |  |
| Evaluation and next action |  |
| Stop rule |  |

Choose a favorite whose identity and intent are current, not an old card kept by accident.

## Define what “similar” means

Use fields such as:

- narrative structure or episode format;
- tone or pacing;
- subject and setting;
- creator or performer relationship;
- media type and duration;
- language or accessibility requirements;
- release period;
- audience context.

DCMI metadata terms distinguish subject, creator, type, format, language, relation, and date. Those fields can support hypotheses, but source metadata completeness varies.

## Write two hypotheses

Example forms:

- “I value this favorite’s compact mystery structure; test works with a similar structure but a different setting.”
- “I value the creator’s approach; test another work by that creator and one related through subject rather than authorship.”

These are experiment structures, not claims about a real title.

## Include stretch candidates

If every candidate shares title keywords and artwork, discovery becomes repetition. Include at least one candidate that matches the valued dimension while changing media type, release period, setting, or creator. The stretch should remain relevant to the hypothesis, not random.

Norva may offer recommendations derived from connected source data. Treat them as candidates and inspect why they might relate; do not assume the interface’s ordering proves a particular similarity.

## Cap and evaluate

Choose a small candidate limit before browsing. For each candidate, record:

- exact identity;
- relation to hypothesis A or B;
- meaningful difference from the seed;
- required language and subtitle options;
- current source availability;
- next action: sample, shortlist, reject, or investigate.

For an occasion-specific set, use [the themed-shortlist brief](/blog/build-themed-favorites-shortlist/).

Add one negative control: a candidate that shares an obvious surface attribute with the seed but violates the stated hypothesis. Evaluate it beside the plausible candidates. If the process accepts both, the hypothesis is too broad to guide discovery; tighten the relation before browsing again. Keep one rejection reason per candidate, because repeated rejections may reveal that the seed's recorded intent, rather than the recommendation set, needs clarification.

## Keep recommendation and favorite state separate

A candidate should enter favorites only after passing [the admission decision](/blog/decide-what-to-favorite/). “The system suggested it” is not a durable future action. W3C label guidance supports separate controls for “Why recommended,” “Add to shortlist,” and “Favorite.”

## Protect against list inflation

Track the ratio of candidates evaluated to candidates favorited. If nearly every result is saved, tighten the admission test or shorten the experiment. [The favorite-inflation guide](/blog/avoid-favorite-list-inflation/) explains why over-saving weakens later retrieval.

## Close the loop

After sampling a candidate, update the experiment:

- hypothesis supported;
- hypothesis not supported;
- metadata insufficient;
- candidate useful for a different reason;
- no further search needed.

Do not rewrite the original favorite’s reason to justify a recommendation after the fact.

## Common mistakes and limitations

- Using a seed with unclear favorite intent.
- Treating similarity as one universal score.
- Accepting only visually close candidates.
- Saving every recommendation.
- Ignoring version and language requirements.
- Continuing discovery without a stop rule.

## Frequently asked questions

### How many seeds should one search use?

Start with one to keep the hypothesis interpretable. Combine seeds only when you can state what each contributes.

### Do recommendations explain themselves?

Not always. Treat the relationship as unknown unless the interface or source exposes useful evidence.

### Can a rejected candidate remain in a shortlist?

Only if it serves another bounded purpose. Do not preserve it by default.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [W3C: Labeling Controls](https://www.w3.org/WAI/tutorials/forms/labels/)
- [Norva Features](https://norva.tv/#features)
