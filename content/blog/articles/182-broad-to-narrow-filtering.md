---
content_id: "NVB-182"
title: "How to Use Broad-to-Narrow Filtering"
seo_title: "Use Broad-to-Narrow Media Library Filtering"
meta_description: "Use broad-to-narrow media filtering by applying reliable high-coverage requirements first, measuring each reduction, then adding narrower or less complete conditions."
slug: "broad-to-narrow-filtering"
canonical_url: "https://norva.tv/blog/broad-to-narrow-filtering/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Filter Strategies"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should broad-to-narrow filtering be used in a media library?"
supporting_questions:
  - "What makes a filter broad and reliable?"
  - "When should narrowing stop?"
audience:
  - "People narrowing large media result sets"
  - "Catalogue users learning multi-filter workflows"
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
excerpt: "Broad-to-narrow filtering applies the most reliable high-level requirement first, reads the result change, and stops before metadata uncertainty removes useful candidates."
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
parent_pillar: "/blog/media-filter-strategy-guide/"
related_articles:
  - "/blog/choose-first-library-filter/"
  - "/blog/why-filter-order-matters/"
  - "/blog/avoid-overfiltering-library/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://guides.loc.gov/c.php?g=1472768&p=10988945"
  - "https://guides.loc.gov/catalog/advanced-search"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "filter funnel ledger"
  summary: "A funnel ledger records baseline, condition, requirement strength, field confidence, before and after counts, control-item retention, and stop decision at every narrowing step."
  methodology: "Readers begin with a broad reliable field, apply one condition, verify controls, calculate practical reduction, and stop when the set is actionable or the next filter is uncertain."
  asset_urls: []
---

# How to Use Broad-to-Narrow Filtering

> **In short:** Begin with the broadest reliable requirement that removes a meaningful group, such as media type or required source. Inspect the count and known controls, then add one narrower condition. Continue only while each filter expresses a real requirement and produces trustworthy information. Stop when the set is manageable; sorting or direct comparison is often safer than one more uncertain filter.

Broad-to-narrow is not simply “select the leftmost filter first.” It is a sequence from high-confidence context to more specific or less complete metadata.

## Define broad and narrow locally

A broad filter:

- applies to most records;
- has clear semantics;
- is well populated;
- removes a large irrelevant class without targeting one title.

A narrow filter:

- represents a specific preference;
- may apply at version or profile level;
- has lower metadata coverage;
- reduces the set sharply.

Film versus series may be broad. A particular subtitle language on currently available favourites may be narrow.

## Build the filter funnel ledger

| Step | Condition | Must/prefer | Field confidence | Before | After | Control retained? | Continue/stop |
|---|---|---|---|---:|---:|---|---|
| 0 | baseline |  |  |  |  |  |  |
| 1 |  |  |  |  |  |  |  |

Record the baseline query, category, source scope, and sort before filtering. A count without scope cannot be compared later.

## Select the first broad condition

Choose from reliable requirements:

- authorised source, when the source is fixed;
- current availability, when playback now is mandatory;
- film or series type;
- broad category with tested membership;
- a wide year band with understood date semantics.

Use [the first-filter decision guide](/blog/choose-first-library-filter/) when several are plausible.

## Measure each step

After applying a filter:

1. confirm the active label and selected value;
2. record the new result count or visible result shape;
3. check a known matching control remains;
4. inspect a known non-match disappears;
5. note whether available next-filter values changed;
6. decide whether the remaining set is actionable.

A dramatic reduction can be helpful or suspicious. If 500 records become zero after a broad category, remove the filter and validate its metadata.

## Add narrower requirements

Apply year, language, subtitle, favourite, or specialised category conditions only when they matter to the decision. Version-level tracks deserve special care: a group may contain French audio in one version and not another.

The Library of Congress Basic Search guide notes that faceting by a field can exclude records lacking that metadata. A narrow filter may therefore improve precision while reducing coverage.

## Stop at the actionable set

Stop narrowing when:

- all remaining candidates satisfy the must-haves;
- the set can be compared on one screen or short row;
- the next condition is only a preference;
- metadata for the next field is incomplete;
- another filter would eliminate a known control;
- sorting would resolve the remaining choice.

Use [the overfiltering guide](/blog/avoid-overfiltering-library/) when the desire for a tiny set begins to replace the actual viewing requirements.

## Record the narrowing ratio cautiously

For each step, calculate `after ÷ before` to see how much of the set remains. This is a navigation clue, not a quality score. A filter retaining 5% may be perfectly appropriate for a strict source requirement, while retaining 80% may still remove the only irrelevant type.

Do not compare ratios across changing baselines or live source updates.

## Understand filter order

In a static system with pure AND conditions, the final intersection can be identical regardless of order. The path still affects understanding, available option counts, and the point where metadata incompleteness appears. Read [why filter order matters](/blog/why-filter-order-matters/) before optimising only for the smallest immediate count.

Norva can organise compatible authorised sources, but filter fields and metadata coverage depend on source data and current product support.

## Common mistakes and limitations

- Calling a filter broad because it appears first.
- Applying a narrow language condition before verifying versions.
- Focusing only on count reduction.
- Skipping positive and negative controls.
- Continuing after the set is actionable.
- Changing the source baseline during the funnel.

Dynamic catalogues can change counts during a session. Record timing and avoid false precision.

## Frequently asked questions

### Should availability always come first?

Only when current playback is a must-have. For catalogue identification or troubleshooting, availability can hide useful records.

### Is category broader than year?

It depends on the catalogue and values. Use coverage, meaning, and requirement strength rather than a universal hierarchy.

### What if the first filter removes the control item?

Undo it, verify field scope and metadata, and choose another route. Do not continue building on a failed control.

## Your next step

[Explore Norva's features](https://norva.tv/#features)

## Sources

- [Library of Congress: Basic Search and facets](https://guides.loc.gov/c.php?g=1472768&p=10988945)
- [Library of Congress: Advanced Search](https://guides.loc.gov/catalog/advanced-search)
- [Norva features](https://norva.tv/#features)
