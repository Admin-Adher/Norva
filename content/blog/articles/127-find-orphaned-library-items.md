---
content_id: "NVB-127"
title: "How to Find Orphaned Items in a Media Library"
seo_title: "Find Orphaned Media Library Items"
meta_description: "Find orphaned media items by comparing search, categories, source relationships, series links, versions, archive routes, and uncategorized queues."
slug: "find-orphaned-library-items"
canonical_url: "https://norva.tv/blog/find-orphaned-library-items/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I find orphaned items in a media library?"
supporting_questions:
  - "What does orphaned mean in a catalogue?"
  - "How should valid standalone items be distinguished from broken relationships?"
audience:
  - "People auditing media catalogue relationships"
  - "Households cleaning imports or migrations"
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
excerpt: "An orphaned item is reachable through one route but missing an expected category, source, series, version, or archive relationship; standalone items are not automatically broken."
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
  - "/blog/triage-uncategorized-media/"
  - "/blog/resolve-partial-media-imports/"
  - "/blog/media-metadata-quality-audit/"
cta:
  label: "Explore Norva's Catalog Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "route-and-relationship orphan audit"
  summary: "A matrix compares each candidate's search visibility with expected category, source, parent, version, and archive relationships."
  methodology: "Readers derive candidates from inventory differences, test each expected route, and classify valid standalone, missing relationship, source issue, or unresolved."
  asset_urls: []
---

# How to Find Orphaned Items in a Media Library

> **In short:** Define an orphan as an item that exists but lacks an expected relationship or browse route. Compare source inventory with catalogue search, categories, series or episode parents, version groups, and archive mappings. Do not treat a valid standalone work as broken. Classify each candidate before repairing links or metadata.

“Orphaned” is not one universal technical state. In a personal catalogue it may describe an episode without a series link, a version without its work group, an item found by search but no category, or an archive entry with no return route.

## Define the expected relationship

For each item type, state what should connect it:

- films may require source, media type, and browse category;
- episodes may require series, season, and sequence context;
- versions may require a shared work relationship;
- archive items need archive group and retrieval route;
- migrated items need a source or batch mapping;
- standalone recordings may legitimately have no parent.

Dublin Core relationship terms such as `isPartOf`, `hasPart`, `isVersionOf`, and `hasVersion` provide useful concepts even when the catalogue uses different labels.

## Generate candidates from route differences

Use several comparisons:

1. search finds the item, but browse does not;
2. source inventory lists a group, but catalogue count differs;
3. episode title appears without a season or series;
4. a version appears as a separate duplicate;
5. archived record has no documented route;
6. item is in no category after filters are cleared;
7. migration ledger shows accepted, but destination search does not.

One route failing is a candidate, not proof.

## Clear filters and preserve context

Before classification, record account, profile, source, device, app version, search query, and filters. Clear source, category, availability, language, and archive filters through supported controls.

If the item returns, the issue was view context rather than a missing relationship. Use [the uncategorised item triage](/blog/triage-uncategorized-media/) when no valid category remains.

## Inspect item identity

Confirm:

- stable source identifier when available;
- exact title and version;
- media type;
- date or year;
- series and episode data;
- source availability;
- language labels;
- migration or cleanup history.

Do not attach a candidate to a parent solely from similar artwork or title. Conflicting identity fields belong in [the metadata quality audit](/blog/media-metadata-quality-audit/).

## Classify the cause

Use:

- **Valid standalone:** no parent or grouping is expected.
- **Missing category:** identity is sound, but browse placement is absent.
- **Missing parent:** episode or member lacks an expected collection relationship.
- **Ungrouped version:** work relationship is missing or uncertain.
- **Source unavailable:** relationship may exist, but source data cannot be verified.
- **Partial import:** destination is missing fields or links from an interrupted batch.
- **Unknown:** evidence is insufficient.

The [partial import triage guide](/blog/resolve-partial-media-imports/) handles the last imported state separately.

## Original evidence: orphan audit matrix

| Candidate | Search | Category | Source | Parent/series | Version group | Archive route | Classification |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  | Found / Missing |  |  |  |  |  |  |
|  | Found / Missing |  |  |  |  |  |  |

Choose a known valid standalone item as a control. This prevents the audit from assuming every item needs every relationship.

## Repair one relationship at a time

For confirmed problems:

1. capture the baseline;
2. select the supported source of truth;
3. update the category, parent, or version mapping;
4. refresh the catalogue;
5. test search and browse;
6. verify neighbouring items;
7. record the decision and rollback.

Do not change identity, category, and source in the same step. Norva can organise and group variants from compatible authorised sources, but missing upstream relationships may require source-level correction.

## Common mistakes and limitations

- Calling every standalone item orphaned.
- Auditing with filters active.
- Linking by title or artwork alone.
- Repairing several relationships at once.
- Ignoring migration history.
- Treating an unavailable source as proof that the relationship never existed.
- Deleting candidates instead of classifying them.

The audit detects missing expected context; it does not automatically establish the correct parent or version.

## Frequently asked questions

### Is an uncategorised item always orphaned?

No. It may be valid but awaiting category assignment. “Orphaned” should identify a missing expected relationship, not merely an empty category field.

### Can search find an item with a broken parent link?

Yes. Search and hierarchical browse can rely on different metadata. Test both routes.

### Should an orphan be deleted?

Not from that status alone. Preserve it, establish identity and source, then repair, categorise, archive, or review through an approved process.

## Your next step

[Explore Norva's catalog features](https://norva.tv/#features)

## Sources

- [National Archives: Records inventory introduction](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva features](https://norva.tv/#features)
