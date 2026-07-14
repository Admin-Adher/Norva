---
content_id: "NVB-187"
title: "How to Combine Category and Year Filters"
seo_title: "Combine Category and Year Media Filters"
meta_description: "Combine category and year filters by defining each field, testing them separately, validating their intersection, and documenting ambiguous dates or categories."
slug: "combine-category-and-year-filters"
canonical_url: "https://norva.tv/blog/combine-category-and-year-filters/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Filter Strategies"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should category and year filters be combined in a personal media library?"
supporting_questions:
  - "Which year does a media filter usually describe?"
  - "How can an empty category-year intersection be diagnosed?"
audience:
  - "People narrowing a personal media library by category and year"
  - "Users who need a reproducible two-filter method"
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
excerpt: "A category-year grid tests each condition alone before accepting their intersection."
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
  - "/blog/broad-to-narrow-filtering/"
  - "/blog/why-filter-order-matters/"
  - "/blog/diagnose-empty-filter-results/"
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
  type: "category-year intersection grid"
  summary: "A two-axis worksheet compares category membership and date semantics before the filters are combined."
  methodology: "Readers define the category and year field, test known controls against each filter independently, then record counts and exceptions for the intersection."
  asset_urls: []
---

# How to Combine Category and Year Filters

> **In short:** Define what the category label includes and what the year field means before combining them. Test category alone, then year alone, using at least one known matching title for each. Apply both only after those controls pass, record the count at every step, and treat missing dates or mixed category labels as unknown rather than automatic negatives.

Category and year look like simple filters, but both can hide interpretation problems. A title may have several categories, while “year” might refer to original release, a season, an episode, a restored edition, or a source-specific record.

## Define both axes first

Write the intended meanings in a category-year grid:

| Axis | Selected value | Field meaning | Includes | Excludes | Unknown handling |
|---|---|---|---|---|---|
| Category |  |  |  |  |  |
| Year |  |  |  |  |  |

For category, decide whether the value is a broad family, a specific genre, or an editorial collection. For year, identify the object being dated. Do not assume the interface and source use the same convention.

## Test category independently

Apply category from a clean baseline. Check one known member, one known non-member, and one borderline record with several labels.

Ask:

- Can a record belong to several categories?
- Does selecting several values mean any or all?
- Are uncategorised records excluded?
- Does the category describe a work or a particular version?

The Library of Congress facet guidance notes that records without a relevant field may disappear when a facet is applied. That means “not shown” does not always mean “not in the category.”

## Test the year independently

Reset, then apply only the year or range. Use a title with an unambiguous original date and one with multiple plausible dates.

Record whether boundaries are inclusive. For a 2018–2020 range, verify that both 2018 and 2020 are returned. If the filter has “before” or “after,” test the boundary year directly.

The Library of Congress advanced-search guidance distinguishes date-oriented fields and range searching. The general lesson is to confirm the selected field and its syntax rather than treating every displayed date as interchangeable.

## Build the intersection

Now apply the broader filter first and the narrower second, recording counts:

| State | Result count | Positive control visible? | Exceptions |
|---|---:|---|---|
| Clean baseline |  |  |  |
| Category only |  |  |  |
| Year only |  |  |  |
| Category + year |  |  |  |

If both filters are ordinary AND conditions over a static dataset, the final intersection should be the same whichever is applied first. [The filter-order guide](/blog/why-filter-order-matters/) explains why a different result can reveal dynamic availability, grouping, hidden state, or unusual semantics.

## Start broad enough to learn

Use a broad category and a generous year range initially. Inspect the result set, then narrow one dimension. This [broad-to-narrow method](/blog/broad-to-narrow-filtering/) keeps useful evidence visible and makes the empty transition easy to locate.

Example sequence:

1. Select one category.
2. Confirm representative records.
3. Add a decade rather than a single year.
4. Tighten the range only if the set remains too large.
5. Sort by year after membership is correct.

Sorting is useful for inspection, but it does not replace the year filter.

## Handle mixed or missing metadata

When expected records disappear, compare the displayed date with the actual field used by the filter. Check whether grouped versions carry different years or category labels. A remastered version may be dated differently from the underlying work.

Do not “repair” the combination by adding unrelated filters. Remove the most recent condition, run known controls, and use [the empty-result rollback ladder](/blog/diagnose-empty-filter-results/) if needed.

Norva may help organise compatible sources a user is authorised to access, but available category and date values depend on the connected source and its metadata. Document exceptions rather than inferring missing facts.

## Common mistakes and limitations

- Treating category labels as a universal taxonomy.
- Assuming every displayed year means original release year.
- Forgetting inclusive range boundaries.
- Combining filters before testing either alone.
- Interpreting missing metadata as a negative match.
- Confusing a year sort with a year restriction.

The grid improves diagnosis; it cannot make inconsistent source fields equivalent.

## Frequently asked questions

### Which filter should come first?

Begin with the one that gives a useful, inspectable set. For static AND filters, order should not change final membership.

### Should I use a single year or a range?

Start with a range when date semantics or coverage are uncertain. Narrow after controls pass.

### What if a title has several categories?

Confirm whether category matching is inclusive and whether multiple selected values use any-match or all-match logic.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [Library of Congress: Basic Search and facets](https://guides.loc.gov/c.php?g=1472768&p=10988945)
- [Library of Congress: Advanced Search](https://guides.loc.gov/catalog/advanced-search)
- [Norva Features](https://norva.tv/#features)
