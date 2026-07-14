---
content_id: "NVB-110"
title: "How to Plan a Library Migration Without Creating New Clutter"
seo_title: "Plan a Clean Media Library Migration"
meta_description: "Plan a media library migration with inventory, mapping, pilot batches, exception queues, reconciliation, rollback, and a controlled cutover."
slug: "plan-library-migration"
canonical_url: "https://norva.tv/blog/plan-library-migration/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Collection Planning"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How can I plan a media library migration without creating new clutter?"
supporting_questions:
  - "Which mappings and checks belong before cutover?"
  - "How can migration changes remain reversible?"
audience:
  - "People moving or combining a media library"
  - "Households changing sources or organisation systems"
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
estimated_reading_minutes: 7
excerpt: "A clean migration separates inventory, mapping, pilot, exceptions, reconciliation, and cutover so uncertainty does not become duplicate clutter."
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
parent_pillar: "/blog/plan-personal-media-collection/"
related_articles:
  - "/blog/build-media-source-inventory/"
  - "/blog/plan-metadata-rules-before-import/"
  - "/blog/make-catalog-cleanup-reversible/"
cta:
  label: "Review How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "consideration"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://www.archives.gov/files/preservation/formats/pdf/naming-and-organizing-files.pdf"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "migration reconciliation worksheet"
  summary: "A batch-level ledger maps source groups to destinations and records counts, exceptions, validation, rollback, and approval."
  methodology: "Readers preserve a source inventory, migrate a representative read-only or reversible pilot, reconcile expected and observed states, and cut over only after essential tasks pass."
  asset_urls: []
---

# How to Plan a Library Migration Without Creating New Clutter

> **In short:** Inventory the source, define the destination rules, map fields and categories, and migrate a representative pilot before the full library. Send ambiguous items to an exception queue rather than duplicating or guessing. Reconcile expected and observed results, preserve a rollback route, and retire the old view only after essential retrieval tasks pass.

Migration is not the same as cleanup. It changes where or how a collection is represented. Combining migration and unrecorded cleanup makes it difficult to tell whether an item was lost, renamed, merged, or intentionally excluded.

## Freeze the planning baseline

Before changing anything, record:

- source labels and owners;
- authorisation status;
- collection groups and approximate counts;
- category and metadata conventions;
- known duplicates and unavailable items;
- active and archive boundaries;
- essential household retrieval tasks;
- current app, device, or system versions;
- recovery and rollback options.

Use [the media source inventory](/blog/build-media-source-inventory/) as the baseline. Do not store credentials in it.

## Define what migration means

Choose the exact operation:

- connecting an additional authorised source into one organised view;
- changing category structure;
- moving catalogue metadata between systems;
- relocating files the user owns and is authorised to move;
- replacing one source with another;
- rebuilding indexes without moving underlying media.

These operations have different risks. Confirm rights, source terms, and technical support before moving or copying media. Norva organises compatible authorised sources; it does not grant permission to transfer source material.

## Map source to destination

Create explicit mappings for:

- source identifiers;
- title fields;
- media types;
- date or year;
- language fields;
- version relationships;
- categories;
- availability;
- personal state such as favourites or progress, only when supported;
- archive status.

Mark every unsupported field. Do not silently squeeze several meanings into one destination field. Establish consistent rules with [the pre-import metadata guide](/blog/plan-metadata-rules-before-import/).

## Build an exception queue

Route these items out of the automatic path:

- ambiguous duplicates;
- missing identifiers;
- conflicting titles or dates;
- mixed languages with unclear labels;
- unsupported formats;
- uncertain authorisation;
- items whose destination is unclear;
- partial or failed transfers.

An exception queue is evidence that the migration is controlled, not a failure. Give every exception a reason, owner, and review date.

## Pilot a representative batch

Choose a small batch covering:

- each media type;
- each source;
- one duplicate candidate;
- one multilingual item;
- one version group;
- one archive item;
- one known metadata gap.

Migrate or connect only that batch through a supported reversible process. Test search, browse, version choice, language evidence, playback where authorised, and return navigation. Do not extrapolate from only easy items.

## Reconcile before cutover

Compare expected and observed states:

- number of groups processed;
- items accepted;
- items in exceptions;
- fields preserved;
- fields transformed;
- categories created;
- duplicates introduced;
- retrieval tests passed;
- rollback tested.

NDSA preservation guidance emphasises inventory, storage, integrity, metadata, and formats. Its institutional levels are not a household migration recipe, but they reinforce the need to know what moved and whether it remained usable.

## Original evidence: migration ledger

| Batch | Source group | Expected | Accepted | Exceptions | Retrieval tests | Rollback | Approval |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Pilot 1 |  |  |  |  | Pass / Recheck | Tested / Untested |  |
| Pilot 2 |  |  |  |  | Pass / Recheck | Tested / Untested |  |

Add notes for every transformation. If the ledger does not reconcile, stop the next batch. Use [the reversible cleanup guide](/blog/make-catalog-cleanup-reversible/) for snapshots, change sets, and rollback checkpoints.

## Cut over without duplicating daily work

Choose a clear cutover date. After approval:

1. stop routine edits in the old view;
2. process final changes;
3. reconcile again;
4. make the destination the active view;
5. keep the old view read-only during a defined verification period when permitted;
6. remove or archive it only through an authorised process.

Avoid maintaining two active structures indefinitely. They will diverge.

## Common mistakes and limitations

- Cleaning and migrating without separate records.
- Treating title matches as proven duplicates.
- Moving media without confirmed rights or source support.
- Importing unsupported fields into misleading destinations.
- Testing only simple items.
- Deleting the baseline before reconciliation.
- Running full batches while the exception queue grows.

Migration behaviour depends on the source, destination, device, and supported export or import routes. Verify current documentation.

## Frequently asked questions

### Should I clean the source before migrating?

Correct clear, reversible issues if they reduce mapping ambiguity, but keep cleanup decisions recorded separately. Do not hide uncertain changes inside migration.

### How large should the pilot be?

Large enough to include every important type of edge case, but small enough to inspect item by item and roll back safely.

### When can the old library be removed?

Only after reconciliation, essential retrieval tests, household approval, and a verified retention or rollback decision under the applicable source rules.

## Your next step

[Review how Norva works](https://norva.tv/#how-it-works)

## Sources

- [National Archives: Records inventory introduction](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [National Archives: Naming and organising files](https://www.archives.gov/files/preservation/formats/pdf/naming-and-organizing-files.pdf)
- [How Norva works](https://norva.tv/#how-it-works)
