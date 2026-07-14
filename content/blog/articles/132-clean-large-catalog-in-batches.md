---
content_id: "NVB-132"
title: "How to Clean a Large Catalog in Manageable Batches"
seo_title: "Clean a Large Media Catalog in Batches"
meta_description: "Clean a large media catalog safely by defining batch boundaries, entry criteria, evidence, validation tests, work limits, rollback, and a batch ledger."
slug: "clean-large-catalog-in-batches"
canonical_url: "https://norva.tv/blog/clean-large-catalog-in-batches/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How can I clean a large media catalogue in manageable batches?"
supporting_questions:
  - "What makes a safe cleanup batch?"
  - "How should progress and rollback be tracked?"
audience:
  - "People with large personal media catalogues"
  - "Households coordinating gradual cleanup"
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
excerpt: "Large-catalogue cleanup becomes manageable when every batch has one cause, a fixed boundary, a baseline, tests, rollback, and a recorded outcome."
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
  - "/blog/prioritize-catalog-cleanup-backlog/"
  - "/blog/make-catalog-cleanup-reversible/"
  - "/blog/catalog-cleanup-quality-checklist/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "cleanup batch passport and ledger"
  summary: "A reusable passport defines one batch's boundary, baseline, dependencies, tests, rollback, owner, and final disposition."
  methodology: "Readers select one coherent slice, limit work in progress, run before-and-after tests, and close each batch in a cumulative ledger before opening another."
  asset_urls: []
---

# How to Clean a Large Catalog in Manageable Batches

> **In short:** Divide a large cleanup by one meaningful boundary—such as source, section, issue type, or alphabetic range—not by an arbitrary record count. Give every batch entry criteria, a baseline, an owner, validation tests, and rollback. Keep only one or two batches active, close each in a ledger, and use the evidence to size the next one.

Trying to “clean the catalogue” as one project makes cause, progress, and recovery difficult to see. A batch should be small enough to inspect and undo, yet coherent enough that one rule and one test set apply.

## Choose a boundary that preserves meaning

Useful boundaries include:

- one source or migration batch;
- one category family;
- one series and its episode relationships;
- one issue type, such as empty categories;
- one time range or alphabetic segment;
- one version-group review queue.

Avoid combining unrelated actions simply to reach a target count. Fifty title corrections and fifty source removals are not one safe batch. Use [the priority method](/blog/prioritize-catalog-cleanup-backlog/) to select the problem before choosing its size.

## Issue a batch passport

Complete this passport before changing anything:

| Field | Record |
|---|---|
| Batch ID and owner |  |
| Problem statement |  |
| Boundary and exclusions |  |
| Expected record count |  |
| Source and mapping version |  |
| Baseline snapshot or export |  |
| Personal context at risk |  |
| Validation sample |  |
| Success tests |  |
| Rollback route |  |
| Observation window |  |

The Library of Congress describes inventory and custody work as knowing what a collection contains and tracking it across its lifecycle. A batch passport applies that discipline at a personal scale.

## Set entry and exit criteria

A batch may enter active work only when its count is known, evidence is available, dependencies are quiet, and rollback is possible. If a source refresh or migration is still changing the same records, wait.

Exit requires more than “changes saved.” Confirm:

1. the processed and exception counts reconcile;
2. no unexpected items crossed the boundary;
3. search and browse tasks still work;
4. representative versions, series, and language labels are understandable;
5. personal state was preserved where expected;
6. a second supported view refreshes correctly;
7. rollback was either tested or explicitly retained.

Use [the cleanup quality checklist](/blog/catalog-cleanup-quality-checklist/) for the final gate.

## Start smaller than your estimated capacity

The first batch is a calibration batch. Choose a small, varied sample and measure:

- review time per item;
- percentage needing manual judgement;
- exception types;
- failed tests;
- time required for refresh and observation.

If exceptions exceed the expected pattern, stop and refine the rule. Increase the next batch only when the first closes cleanly. A fixed batch size is less useful than a fixed ability to verify it.

## Limit work in progress

Use four lanes: **Ready**, **Active**, **Observe**, and **Closed**. Keep no more than one high-risk or two low-risk batches in Active. Observation is not closure; a batch should remain visible until scheduled checks pass.

Do not begin a new destructive batch while a previous one lacks reconciliation. This limit prevents several rollback windows and mapping versions from becoming entangled.

## Maintain a cumulative batch ledger

For each closed batch, record its passport ID, dates, intended count, changed count, exceptions, test outcome, rollback location, and reviewer decision. Add one sentence about what will change in the next batch.

The ledger becomes evidence for progress and makes repeated work consistent. It also supports [documenting major cleanup changes](/blog/document-catalog-cleanup/) without relying on memory.

## Common mistakes and limitations

- Batching by convenience rather than a shared cause.
- Opening many batches at once.
- Expanding scope after work starts.
- Counting edits but not exceptions.
- Treating an automatic run as self-validating.
- Discarding the baseline immediately after success.

No batch method can make an unsupported source control safe. Norva organises compatible authorised sources, and actual metadata or available operations may vary by source.

## Frequently asked questions

### What is the ideal batch size?

There is no universal number. Choose the largest coherent set that you can count, sample, validate, and reverse within one controlled session.

### Should similar exceptions stay in the same batch?

Move them to an exception queue first. If they share a proven cause and test set, they can become a later dedicated batch.

### Can batches run automatically?

Automation may execute supported, well-tested rules, but the batch still needs boundaries, reconciliation, exception handling, and human review for ambiguous cases.

## Your next step

[Explore Norva's features](https://norva.tv/#features)

## Sources

- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [Norva features](https://norva.tv/#features)
