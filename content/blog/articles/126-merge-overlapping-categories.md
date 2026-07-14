---
content_id: "NVB-126"
title: "When to Merge Overlapping Media Categories"
seo_title: "Merge Overlapping Media Categories"
meta_description: "Decide whether overlapping media categories should merge by comparing meaning, membership, retrieval tasks, ownership, mappings, and rollback."
slug: "merge-overlapping-categories"
canonical_url: "https://norva.tv/blog/merge-overlapping-categories/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "decision-guide"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "When should overlapping media categories be merged?"
supporting_questions:
  - "How can genuine overlap be distinguished from different meanings?"
  - "Which dependencies must be checked before a merge?"
audience:
  - "People cleaning catalogue categories"
  - "Households simplifying shared browse paths"
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
estimated_reading_minutes: 6
excerpt: "Merge categories only when their meanings, membership, owners, and retrieval purpose are genuinely equivalent and the change can be reversed."
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
  - "/blog/standardize-category-names-during-cleanup/"
  - "/blog/make-catalog-cleanup-reversible/"
  - "/blog/catalog-cleanup-quality-checklist/"
cta:
  label: "Explore Norva's Catalog Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/knowing"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "category overlap decision matrix"
  summary: "A membership-and-purpose matrix separates exact duplicates, partial overlap, hierarchy, and unrelated categories before any merge."
  methodology: "Readers compare definitions and representative members, test household retrieval tasks, identify mappings, and pilot one reversible merge."
  asset_urls: []
---

# When to Merge Overlapping Media Categories

> **In short:** Merge categories only when they express the same stable meaning, serve the same retrieval task, and contain substantially equivalent members for the current scope. Keep them separate when overlap reflects different sources, audiences, versions, languages, or active/archive states. Check mappings and rollback before changing the live catalogue.

Two category names can look similar while answering different questions. “Drama” may describe genre, while “Family dramas” may represent a household viewing context. A merge based on labels alone can erase useful intent.

## Define each category before comparing it

For both candidates, record:

- exact label;
- plain-language definition;
- inclusion rule;
- exclusion rule;
- source or person that created it;
- active versus archive status;
- intended viewers;
- retrieval task it supports;
- current mappings and intake rules.

If no one can define a category, classify it for review before treating it as a duplicate.

## Compare membership with a sample

Create three lists:

- items only in Category A;
- items in both categories;
- items only in Category B.

Inspect representative items from every list. Ask whether differences are errors or evidence of separate meanings. Do not use one large overlap percentage as an automatic decision; the exclusive items may be the most important ones.

Use [the pre-cleanup audit](/blog/audit-library-before-cleanup/) to preserve counts, filters, sources, and sample time.

## Classify the relationship

Use one of four states:

- **Exact duplicate:** same meaning and expected membership.
- **Partial overlap:** some shared items, but distinct valid meanings.
- **Hierarchy:** one category is a meaningful subset of the other.
- **Unrelated:** similar labels hide different purposes.

Dublin Core provides broad relationship concepts such as `hasPart` and `isPartOf`. A personal catalogue may not implement those terms formally, but distinguishing equivalence from hierarchy prevents destructive flattening.

## Test household retrieval

Ask regular viewers to find known items through both categories. Record:

- which label they choose first;
- wrong turns;
- whether a unique item becomes harder to find after a proposed merge;
- whether one category is tied to a profile or language need;
- whether search already solves the task.

A merge should simplify an agreed route, not only reduce category count.

## Check dependencies before approval

Search:

- intake rules;
- metadata mappings;
- migration ledgers;
- archive return routes;
- saved household instructions;
- decision log;
- source-generated category behaviour.

If a source defines the category, a local removal may be unsupported or may reappear after refresh. Document the defining layer.

## Original evidence: overlap matrix

| Criterion | Category A | Category B | Decision evidence |
| --- | --- | --- | --- |
| Definition |  |  |  |
| Inclusion/exclusion |  |  |  |
| Unique sample items |  |  |  |
| Shared sample items |  |  |  |
| Viewer task |  |  |  |
| Source/mapping owner |  |  |  |
| Rollback route |  |  |  |

Approve “merge,” “keep separate,” “create hierarchy,” or “review.” Record the reason and date. If labels are the only problem, use [the category naming guide](/blog/standardize-category-names-during-cleanup/) instead of merging.

Keep the completed matrix with the cleanup record so a later reviewer can understand the decision without reconstructing the original catalogue.

## Pilot the merge reversibly

When the evidence supports a merge:

1. capture the baseline and mappings;
2. select one small category pair;
3. redirect intake rules;
4. move or relabel only through supported controls;
5. verify no items became uncategorised;
6. rerun retrieval tasks;
7. refresh a second supported view;
8. test rollback.

Follow [the reversible cleanup process](/blog/make-catalog-cleanup-reversible/) and include the result in [the final cleanup checklist](/blog/catalog-cleanup-quality-checklist/).

## Common mistakes and limitations

- Merging from similar names alone.
- Ignoring exclusive members.
- Flattening a useful parent-child relationship.
- Removing a source-defined label without checking refresh behaviour.
- Updating categories but not intake mappings.
- Measuring success only by fewer labels.
- Processing many merges without a pilot.

Norva can organise compatible authorised sources, but source category definitions and metadata may change independently.

## Frequently asked questions

### How much overlap is enough to merge?

There is no universal percentage. Meaning, unique members, retrieval purpose, source ownership, and dependencies matter more than one numeric threshold.

### Can two categories share items and remain separate?

Yes. Genre, language, source, household context, and archive status can validly overlap while serving different tasks.

### What if one label is simply clearer?

Consider standardising the name and redirecting mappings while preserving the category relationship. A rename may solve the problem without a merge.

## Your next step

[Explore Norva's catalog features](https://norva.tv/#features)

## Sources

- [National Archives: Knowing your records](https://www.archives.gov/records-mgmt/scheduling/knowing)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva features](https://norva.tv/#features)
