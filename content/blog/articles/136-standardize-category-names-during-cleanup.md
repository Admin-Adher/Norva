---
content_id: "NVB-136"
title: "How to Standardize Category Names During Cleanup"
seo_title: "Standardize Media Category Names During Cleanup"
meta_description: "Standardize media category names with a naming contract, preferred labels, aliases, scope checks, mapping updates, pilot changes, and retrieval tests."
slug: "standardize-category-names-during-cleanup"
canonical_url: "https://norva.tv/blog/standardize-category-names-during-cleanup/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should media category names be standardised during cleanup?"
supporting_questions:
  - "How can labels be made consistent without losing meaning?"
  - "Which mappings and retrieval tasks should be tested after a rename?"
audience:
  - "People cleaning a personal media catalogue"
  - "Households with inconsistent category labels"
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
excerpt: "Category-name cleanup should preserve meaning and source relationships through a written naming contract, alias register, mapping review, and retrieval test."
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
  - "/blog/merge-overlapping-categories/"
  - "/blog/remove-empty-library-categories/"
  - "/blog/document-catalog-cleanup/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.archives.gov/files/preservation/formats/pdf/naming-and-organizing-files.pdf"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "category naming contract and alias register"
  summary: "A naming contract defines label purpose, grammar, vocabulary, hierarchy, exceptions, and source ownership while an alias register preserves former terms."
  methodology: "Readers inventory names, separate labels from concepts, approve preferred forms, update mappings in a pilot, and validate real browse and search tasks."
  asset_urls: []
---

# How to Standardize Category Names During Cleanup

> **In short:** Standardise the concept before the spelling. Inventory current labels, define what each category includes and excludes, select a preferred form, retain former names as aliases in a register, and identify source-owned labels that may return on refresh. Pilot renames with mapping and retrieval tests; do not merge distinct meanings merely to achieve visual consistency.

Inconsistent names slow scanning and create duplicate intake rules, but a tidy label can still hide an incoherent category. Naming cleanup succeeds when people can predict where an item belongs and how to find it.

## Separate labels from concepts

For each category, record its current label, definition, inclusion rule, exclusion rule, parent, sample members, source, and owner. Labels such as “Kids,” “Family,” and “Family viewing” may be synonyms, overlapping concepts, or deliberately different routes.

If membership and purpose overlap, use [the category merge decision guide](/blog/merge-overlapping-categories/). If they differ, preserve the distinction and improve the names.

## Write a category naming contract

Define rules once before renaming individual labels:

| Rule | Decision |
|---|---|
| Preferred language and regional form |  |
| Singular or plural nouns |  |
| Capitalisation |  |
| Abbreviations permitted |  |
| Punctuation and separators |  |
| Date or year format |  |
| Hierarchy notation |  |
| Source names permitted |  |
| Maximum useful label length |  |
| Approved exceptions |  |

Use plain labels that describe the category’s purpose. Avoid unexplained internal codes, decorative prefixes that break alphabetical scanning, and temporary words such as “new” when no expiry rule exists.

The National Archives naming guidance emphasises concise, meaningful names and documented conventions. The principle applies even when the catalogue uses labels rather than filenames.

## Maintain a preferred-label register

Create one row for every concept:

| Concept ID | Preferred label | Former labels | Definition | Parent | Source/mapping owner | Status |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

The concept ID need only be stable inside your cleanup record. Former labels help reviewers understand imports, searches, and household vocabulary. Mark source-defined labels separately; a local rename may be overwritten or duplicated after refresh.

Do not erase an old label from the register simply because the interface no longer shows it. It remains part of the decision history.

## Choose the right action

Classify each candidate as:

- **Keep:** already follows the contract and conveys the right meaning.
- **Rename:** meaning stays the same; only the preferred label changes.
- **Clarify:** definition or boundaries need review before naming.
- **Merge review:** likely duplicate concept, requiring membership analysis.
- **Hierarchy review:** labels represent parent and child concepts.
- **Retire review:** category may be empty or obsolete.

Use [the empty-category workflow](/blog/remove-empty-library-categories/) instead of casually deleting a label with no visible members.

## Pilot mappings, not just display text

Select a small category family. Capture its members, intake rules, source mapping, browse position, and common search terms. Apply the supported rename or mapping change, then verify:

1. existing members remain present;
2. a newly refreshed item enters the intended category;
3. old mappings do not recreate a duplicate label;
4. search and browse tasks still work;
5. the name is legible on web, mobile, and TV where supported;
6. household members interpret it consistently;
7. rollback restores the baseline.

Norva can organise categories from compatible authorised sources, but source-defined names and metadata may vary or change independently.

## Document decisions and exceptions

Record the before label, after label, concept ID, reason, affected mappings, validation result, and date. Use [the cleanup documentation guide](/blog/document-catalog-cleanup/) for large batches.

Exceptions should be explicit. A recognised proper name, established franchise styling, or source requirement may legitimately override the default convention.

## Common mistakes and limitations

- Renaming before defining category purpose.
- Forcing every label into one grammatical pattern.
- Merging categories because names look similar.
- Ignoring old intake rules and source mappings.
- Removing aliases from the change history.
- Testing on one screen size only.

Naming conventions improve predictability, not metadata truth. They cannot resolve uncertain membership without separate evidence.

## Frequently asked questions

### Should category names include item counts?

Usually not in the stored label. Counts change and may be supplied by the interface. If a count is operationally necessary, define how and when it refreshes.

### Is title case better than sentence case?

Either can work. Choose one readable convention for ordinary labels, preserve intentional proper names, and test it in the actual interface.

### What if household members use different words?

Choose a clear preferred label and retain common former terms in the alias register. If supported search behaviour recognises aliases, validate it rather than assuming.

## Your next step

[Explore Norva's features](https://norva.tv/#features)

## Sources

- [National Archives: Naming and organizing files](https://www.archives.gov/files/preservation/formats/pdf/naming-and-organizing-files.pdf)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva features](https://norva.tv/#features)
