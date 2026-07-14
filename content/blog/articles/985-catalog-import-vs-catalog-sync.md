---
content_id: "NVB-985"
title: "Catalog Import vs. Catalog Sync: What Each Process Does"
seo_title: "Catalog Import vs Catalog Sync Explained"
meta_description: "Learn how catalog import differs from sync in purpose, timing, baseline creation, change detection, conflict handling, evidence, recovery, and expectations."
slug: "catalog-import-vs-catalog-sync"
canonical_url: "https://norva.tv/blog/catalog-import-vs-catalog-sync/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "catalog-process-concept-comparison"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between catalog import and catalog synchronization?"
supporting_questions:
  - "How do baseline creation, later updates, conflicts, and recovery differ?"
  - "Which evidence helps diagnose a first-load issue versus a stale catalog?"
audience:
  - "Media player users"
  - "Norva catalog administrators"
author: { name: "", profile_url: "" }
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
estimated_reading_minutes: 7
excerpt: "Import establishes an organized baseline from source information; synchronization later reconciles changes with an existing catalog state."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-player-glossary/"
related_articles:
  - "/blog/media-player-glossary/"
  - "/blog/media-source-vs-media-catalog/"
  - "/blog/catalog-audit-after-source-change/"
cta:
  label: "Review Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "import-sync lifecycle trace"
  summary: "A lifecycle trace records initial source baseline, import signals, verified catalog sample, later source changes, synchronization observations, conflicts, and recovery decisions."
  methodology: "The administrator fixes one authorized source, documents three known items before import, introduces or observes one legitimate later change, and separates process signals from catalog outcomes."
  asset_urls: []
---

# Catalog Import vs. Catalog Sync: What Each Process Does

> **In short:** A catalog import establishes an organized baseline from available source information. Catalog synchronization later reconciles additions, removals, metadata changes, availability, or state against an existing catalog. Products may use different labels, but first-load evidence and ongoing-update evidence should be collected separately.

Users often call every catalog update an import. That makes troubleshooting harder: a missing item during the first baseline is not the same problem as a previously visible item failing to reflect a later source change.

The [media player glossary](/blog/media-player-glossary/) places both processes between the source and organized catalog.

## Import establishes a baseline

During an initial import, the organizer reads available records from a compatible authorized source, interprets metadata, and creates its first browsable representation. It may identify media type, hierarchy, variants, artwork, and language information from source-derived data.

An initial item count is not a complete quality measure. Grouping, filters, unsupported records, and source metadata can affect what appears.

## Synchronization compares later state

Synchronization begins with an existing catalog. It seeks to reconcile what has changed since the prior known state. Changes may include new or removed records, corrected metadata, availability differences, or updated viewing context, depending on the product and scope.

Do not assume the process is continuous or instantaneous. Observe current interface signals and official guidance rather than inventing an interval.

## Their starting evidence differs

For import, record the source's expected broad scope, three known items, start time, visible process states, first recognizable result, completion or stable state, and a post-import sample.

For synchronization, record the previously verified catalog state, the exact legitimate source change, when it occurred, the sync or refresh action, and the resulting catalog state.

## Source changes must be controlled

Do not edit several source records while testing one synchronization behavior. A single known addition or correction creates a clearer trace. Never remove valuable media solely to provoke a test.

The [source versus catalog guide](/blog/media-source-vs-media-catalog/) explains why the source baseline and catalog observation belong in separate columns.

## Conflicts can appear during synchronization

If both source metadata and organizer state change, the process may face ambiguous identity, grouping, or user-state decisions. A later record can resemble an existing item without being the same version. The result may be grouped, separated, duplicated, stale, or unknown.

Preserve the pre-sync state before renaming, deleting, or reconnecting anything.

## Failure symptoms differ

An import issue can produce no baseline, a partial baseline, wrong hierarchy, or missing representative items. A synchronization issue can produce stale records, unexpected removals, delayed updates, conflicts, or a mismatch between screens.

An explicit error is stronger evidence than a quiet period. Record the exact sanitized message and stage.

## Recovery should match the process

For import, confirm authorization, source reachability, account and profile, expected scope, and stable process state before retrying. For sync, confirm the prior verified state, actual source change, filters, grouping, and supported refresh path.

Avoid deleting the entire catalog connection to repair one stale record. Use official support when the minimum reproducible case persists.

## Audit after a source change

The [catalog audit after a source change](/blog/catalog-audit-after-source-change/) expands a synchronization check into a representative review of identity, hierarchy, variants, filters, tracks, and playback. It should not be confused with repeating first-time onboarding.

## Original evidence: lifecycle trace

| Stage | Source evidence | Process signal | Catalog observation | Decision |
| --- | --- | --- | --- | --- |
| Pre-import | Scope and three known items | Not started | No baseline | Start authorized import |
| Import | Source reachable | State changes and time | Partial results | Observe |
| Post-import | Same sample | Stable or complete state | Verified baseline | Accept or investigate |
| Later source change | One known addition or correction | Change timestamp | Old catalog state | Run supported sync |
| Post-sync | Updated source baseline | Refresh or sync signal | Updated, stale, conflict, unknown | Accept, wait, or investigate |

## Common process mistakes

- Calling every refresh an import.
- Judging quality from an item count alone.
- Changing several source records during one test.
- Assuming a quiet interface proves failure.
- Deleting the connection before preserving the baseline.
- Treating similar records as definite duplicates.

## Frequently asked questions

### Does synchronization always run automatically?

Do not assume so. Timing and controls are product-specific. Follow current official interface and support guidance.

### Should a source correction appear immediately?

No universal delay can be promised. Record when the source change became authoritative, the supported sync action, and the resulting catalog state.

### Is reconnecting the source the first recovery step?

Usually not. Confirm source state, filters, grouping, process signals, and one reproducible item before using a disruptive recovery action.

## Your next step

[Review Norva Support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva support](https://norva.tv/support)
