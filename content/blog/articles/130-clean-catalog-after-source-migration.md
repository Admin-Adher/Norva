---
content_id: "NVB-130"
title: "A Safe Catalog Cleanup After a Source Migration"
seo_title: "Safe Catalog Cleanup After Source Migration"
meta_description: "Clean a catalog after source migration by reconciling batches, preserving personal state, resolving duplicates, retiring mappings, and validating rollback."
slug: "clean-catalog-after-source-migration"
canonical_url: "https://norva.tv/blog/clean-catalog-after-source-migration/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I clean a media catalogue after a source migration?"
supporting_questions:
  - "Which checks must pass before old structures are removed?"
  - "How can personal state and version context be preserved?"
audience:
  - "People completing a media source migration"
  - "Households reconciling old and new catalogue views"
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
excerpt: "Post-migration cleanup begins after reconciliation, not immediately after import, and removes only proven remnants while preserving source, version, and personal context."
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
  - "/blog/plan-library-migration/"
  - "/blog/resolve-partial-media-imports/"
  - "/blog/cleanup-without-losing-personal-state/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "post-migration retirement checklist"
  summary: "A source-to-destination reconciliation and dependency checklist blocks premature removal of old categories, mappings, and views."
  methodology: "Readers validate representative records and personal state, classify remnants, pilot retirement, and keep the rollback window until essential tasks pass."
  asset_urls: []
---

# A Safe Catalog Cleanup After a Source Migration

> **In short:** Do not clean immediately after the last import. First reconcile source and destination groups, verify representative items and relationships, confirm personal state, and resolve partial or duplicate records. Classify old categories and mappings as required, temporary, obsolete, or unresolved. Retire only proven remnants through a reversible approved batch.

Migration often creates temporary labels, duplicate views, exception queues, and parallel source mappings. Some are clutter; others are the evidence needed to prove the move succeeded.

## Confirm migration closure criteria

Before cleanup, require:

- every planned batch has a status;
- expected, accepted, rejected, and uncertain counts reconcile;
- partial imports are resolved or owned;
- essential search and browse tasks pass;
- series, episodes, and versions retain relationships;
- language metadata is understandable;
- source ownership and authorisation remain documented;
- rollback or old-view retention decision is approved.

Return to [the migration plan](/blog/plan-library-migration/) when any criterion is incomplete.

## Preserve source and destination baselines

Keep the pre-migration inventory, mapping version, batch ledgers, destination snapshot, error logs, and decision history. Record what the old source view still contains.

Do not store credentials in the migration record. A source inventory should identify owners and recovery routes without exposing secrets.

## Validate representative records

Select:

- one item from every migrated source group;
- one episode relationship;
- one multi-version work;
- one multilingual item;
- one unavailable item;
- one archive item;
- one previously failed record;
- one likely duplicate.

Test search, category browse, details, relationship, source label, and playback only where authorised. A visible title is not enough.

## Verify personal context separately

Catalogue structure and personal state are different layers. Check the intended profiles for:

- playback progress;
- history;
- favourites;
- language and subtitle preferences;
- continue-watching context.

Do not infer that migration preserved personal state unless the supported workflow says so and your test confirms it. Use [the personal-context cleanup guide](/blog/cleanup-without-losing-personal-state/) before removing an old view.

## Classify migration remnants

- **Required:** current mappings or categories still used by intake.
- **Temporary:** needed until a defined verification date.
- **Obsolete:** no members, dependencies, or approved purpose.
- **Exception:** tied to unresolved records.
- **Rollback:** retained specifically for recovery.
- **Unknown:** evidence missing.

Do not remove “unknown” to make the catalogue look finished.

## Resolve duplicates and partial records

Matching titles across old and new sources are candidates, not proof of duplicate media. Compare identifiers, versions, language, availability, rights context, and migration history.

If an import stopped or produced uncertain records, use [the partial import triage ledger](/blog/resolve-partial-media-imports/) before deduplication.

## Original evidence: retirement checklist

| Remnant | Defining layer | Members/dependencies | Classification | Rollback need | Approved action |
| --- | --- | --- | --- | --- | --- |
| Old category |  |  | Required / Temporary / Obsolete / Exception / Rollback / Unknown |  |  |
| Mapping |  |  |  |  |  |
| Old source view |  |  |  |  |  |
| Exception queue |  |  |  |  |  |

Pilot one obsolete category or mapping. Refresh, rerun control tasks, and verify that no record becomes orphaned.

## Retire the old structure deliberately

When approved:

1. stop new edits in the old view;
2. process final reconciled changes;
3. update intake mappings;
4. remove one obsolete remnant;
5. test search and browse;
6. verify personal context;
7. document the result;
8. retain rollback until the agreed window closes.

Do not maintain two active catalogues indefinitely. They will diverge and create new ambiguity.

Before closing rollback, reopen one migrated item from each media type and confirm its identity, source, personal state, and retrieval path.

## Common mistakes and limitations

- Cleaning before migration counts reconcile.
- Deleting exception queues as clutter.
- Assuming matching titles are identical versions.
- Ignoring profiles and personal state.
- Removing the old source view before rollback approval.
- Changing mappings and categories in one undocumented batch.
- Treating migration success as permanent source availability.

Migration and cleanup depend on current source and destination capabilities. Use supported routes and confirm associated rights.

## Frequently asked questions

### How long should the old view remain?

Use a defined verification window based on migration risk, retrieval tests, and source rules. There is no universal duration.

### Can temporary categories be deleted immediately after import?

Only after mappings, exception records, and control items show they have no remaining purpose or dependency.

### What if personal progress differs after migration?

Stop cleanup, confirm account, profile, item, and version, and preserve both states. Do not overwrite the desired context until the cause is understood.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [National Archives: Records inventory introduction](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [Norva support](https://norva.tv/support)
