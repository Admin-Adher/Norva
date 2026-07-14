---
content_id: "NVB-138"
title: "Why You Should Document Major Catalog Cleanup Changes"
seo_title: "Document Major Media Catalog Cleanup Changes"
meta_description: "Document major catalog cleanup changes with a concise record of scope, evidence, mappings, decisions, counts, tests, exceptions, rollback, and ownership."
slug: "document-catalog-cleanup"
canonical_url: "https://norva.tv/blog/document-catalog-cleanup/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "concept-explainer"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Why should major media catalogue cleanup changes be documented?"
supporting_questions:
  - "What belongs in a useful cleanup record?"
  - "How can documentation stay concise and actionable?"
audience:
  - "People planning major catalogue cleanup"
  - "Households coordinating migrations or structural changes"
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
excerpt: "A concise cleanup record preserves why a change was made, what it touched, how it was verified, and how to recover or investigate later."
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
  - "/blog/make-catalog-cleanup-reversible/"
  - "/blog/clean-large-catalog-in-batches/"
  - "/blog/catalog-cleanup-quality-checklist/"
cta:
  label: "View Norva Support"
  href: "https://norva.tv/support"
  intent: "consideration"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "catalogue change record"
  summary: "A one-page change record links purpose, scope, evidence, before-and-after counts, mapping version, tests, exceptions, approval, and rollback."
  methodology: "Readers create the record before work, update it at batch boundaries, attach evidence by stable reference, and close it only after reconciliation and observation."
  asset_urls: []
---

# Why You Should Document Major Catalog Cleanup Changes

> **In short:** Document major cleanup so the next person can answer what changed, why, where, when, by whom, with which evidence, and how it can be tested or reversed. A useful record is not a diary of clicks. It connects the intended outcome, affected scope, before-and-after counts, mapping version, exceptions, validation results, and rollback route.

Without a change record, a later source refresh can make an intentional rename look like an error, or an old temporary category look safe to remove. Documentation protects reasoning as much as data.

## Know which changes deserve a record

Create a formal record when a change affects any of these:

- many records or an entire category family;
- source connections or mappings;
- series, episode, or version relationships;
- progress, favourites, history, or profile context;
- a migration or partial import;
- removal, deletion, or another difficult-to-reverse action;
- household naming and organisation conventions.

Small reversible corrections can use a lighter log, but repeated small changes should still be grouped under a dated maintenance record.

## Use the catalogue change record

Complete this concise structure:

| Section | Required information |
|---|---|
| Identity | Change ID, title, owner, dates, reviewer |
| Purpose | Observable problem and desired outcome |
| Scope | Included and excluded sources, sections, records, profiles |
| Baseline | Counts, samples, mapping version, known pre-existing exceptions |
| Decision | Options considered, chosen action, reason |
| Execution | Batch IDs, tools or controls used, start and finish |
| Validation | Retrieval tasks, relationship tests, device views, results |
| Reconciliation | Expected, changed, unchanged, failed, uncertain counts |
| Recovery | Snapshot or export reference, rollback steps, retention window |
| Closure | Exceptions, follow-up owner, observation result, approval |

Use stable references to evidence rather than embedding a pile of screenshots. The National Archives treats inventory as a way to understand records, their location, arrangement, volume, and use. Your record should make the changed catalogue similarly intelligible.

## Write the decision before execution

Documenting the intended change first exposes ambiguity. “Remove duplicates” is incomplete. “Review 26 records created by migration batch M-04, retain the verified preferred version, preserve personal context, and isolate unresolved pairs” is testable.

Link the decision to [the reversible cleanup plan](/blog/make-catalog-cleanup-reversible/) and state the stop conditions. Approval should cover the bounded action, not unlimited cleanup.

## Reconcile numbers and exceptions

Record expected and actual counts. A useful equation is:

**scope = changed + intentionally unchanged + exceptions + unresolved**

Every record in scope needs a final category. If totals do not reconcile, the change stays open. For a large project, reuse the ledger from [the batch-cleaning workflow](/blog/clean-large-catalog-in-batches/).

Exceptions require cause, evidence, current state, owner, and next review date. “Skipped” is not sufficient because it cannot distinguish a deliberate exclusion from an overlooked item.

## Capture validation as tasks

Do not write only “tested successfully.” Name the task, sample, view, expected result, actual result, and time. Examples include finding a title from search, opening the correct version, browsing a renamed category, resuming a partial episode, or confirming a refreshed item follows the intended mapping.

Complete [the cleanup quality checklist](/blog/catalog-cleanup-quality-checklist/) and attach its result to the change ID.

## Keep records maintainable

Store records in one known location with a consistent name, such as `YYYY-MM-DD_change-ID_short-description`. Restrict edits appropriately, retain earlier decisions, and link superseding records instead of silently rewriting history.

Protect sensitive household information. Record the minimum needed to verify the change, avoid exposing account credentials or unnecessary viewing details, and follow applicable privacy requirements.

## Common mistakes and limitations

- Recording clicks but not the desired outcome.
- Omitting exclusions and pre-existing errors.
- Saving screenshots with no date or record reference.
- Claiming success without reconciled counts.
- Keeping rollback files without restoration instructions.
- Editing old decisions to match later events.

Documentation does not make an unsafe action safe. It makes assumptions visible and supports review, recovery, and learning.

## Frequently asked questions

### How long should cleanup records be kept?

Keep them through the rollback and observation window at minimum. Retain major migration and structural decisions longer when they explain current mappings or organisation.

### Do screenshots count as documentation?

They can support a record but rarely replace it. A screenshot may show appearance without scope, cause, counts, or recovery instructions.

### Who should approve a household cleanup?

The person authorised to change the affected source or shared organisation should approve it, with input from profiles whose personal context may be affected.

## Your next step

[View Norva Support](https://norva.tv/support)

## Sources

- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva Support](https://norva.tv/support)
