---
content_id: "NVB-129"
title: "How to Triage a Partial Media Import"
seo_title: "Triage a Partial Media Library Import"
meta_description: "Triage a partial media import by freezing retries, preserving logs, reconciling accepted and failed records, isolating duplicates, and testing rollback."
slug: "resolve-partial-media-imports"
canonical_url: "https://norva.tv/blog/resolve-partial-media-imports/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I triage a partial media import?"
supporting_questions:
  - "How can successful and failed records be reconciled?"
  - "When is retrying safe?"
audience:
  - "People recovering from an interrupted catalogue import"
  - "Households cleaning migration remnants"
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
excerpt: "A partial import should be frozen, inventoried, and reconciled before retry so completed records do not become duplicates and failed records remain traceable."
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
  - "/blog/find-orphaned-library-items/"
  - "/blog/clean-catalog-after-source-migration/"
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
  type: "partial import reconciliation ledger"
  summary: "A four-state ledger separates accepted, rejected, uncertain, and duplicate-risk records before any retry."
  methodology: "Readers preserve source and destination snapshots, compare batch identifiers and representative records, retry only a clean isolated remainder, and reconcile again."
  asset_urls: []
---

# How to Triage a Partial Media Import

> **In short:** Stop automatic retries, preserve the source list, destination state, error message, and batch settings. Classify records as accepted, rejected, uncertain, or duplicate risk. Reconcile counts and identifiers, isolate a clean remainder, and retry only through a supported reversible process. Do not rerun the whole batch blindly.

A partial import can leave valid records beside missing relationships, duplicates, or incomplete metadata. Repeating the same import may hide the original failure and make reconciliation harder.

## Freeze the current state

Record:

- import batch name or time;
- source and destination labels;
- mapping or rule version;
- expected record or group count;
- reported accepted, failed, and skipped counts;
- exact error text;
- app or tool version;
- filters and account context;
- whether another retry already occurred.

Do not include credentials, tokens, or private source addresses in the incident record.

## Preserve three baselines

Keep:

1. the source inventory or export used for the batch;
2. the destination state immediately after failure;
3. the import log or error report.

Verify what each artefact contains. A screenshot is useful evidence but rarely captures every identifier or relationship. NDSA preservation guidance emphasises inventory and integrity as separate controls; apply that principle to the catalogue state without claiming a formal preservation programme.

## Classify imported records

Use four states:

- **Accepted:** present with required fields and relationships.
- **Rejected:** explicitly failed with an error.
- **Uncertain:** present, but required fields or relationships cannot be verified.
- **Duplicate risk:** may have been imported more than once or collides with an existing record.

Do not call every present title accepted. Check source identifier, version, category, language fields, and parent relationship where relevant.

## Reconcile with control records

Select:

- one known successful item;
- one known failed item;
- one item near the interruption point;
- one multi-version or episode relationship;
- one existing destination item likely to duplicate.

Search and browse each. Compare with [the migration planning ledger](/blog/plan-library-migration/). If an accepted item cannot be found through its expected route, classify it as uncertain or [potentially orphaned](/blog/find-orphaned-library-items/).

## Identify the failure layer

Possible layers include:

- source data missing or malformed;
- mapping rule conflict;
- unsupported field or relationship;
- destination validation;
- interrupted connection;
- insufficient local resource;
- authorisation or account problem;
- unknown.

Do not assert the cause from timing alone. Change one variable in a small test and preserve the result.

## Build a clean retry set

Exclude accepted and duplicate-risk records. Correct only verified mapping errors, then create a retry set containing records that are clearly rejected and safe to process again.

Test one record or a small representative subset. Confirm:

- no duplicate is created;
- required fields arrive;
- relationships remain intact;
- error no longer occurs;
- rollback is understood.

## Original evidence: reconciliation ledger

| Source record/group | Destination match | Import state | Required fields | Relationship | Retry action |
| --- | --- | --- | --- | --- | --- |
|  |  | Accepted / Rejected / Uncertain / Duplicate risk | Pass / Recheck | Pass / Recheck |  |
|  |  |  |  |  |  |

Reconcile totals: source expected, accepted, rejected, uncertain, and duplicate risk. Stop when categories overlap or counts remain unexplained.

After a successful retry, use [the post-migration cleanup guide](/blog/clean-catalog-after-source-migration/) to remove temporary structures only after verification.

## When to escalate

Contact the source or import-tool provider when the failure exists upstream or in its export. Contact Norva support when a compatible authorised source and verified data produce a reproducible Norva issue.

Provide redacted logs, versions, steps, mapping summary, control records, and time. Never send passwords or secret source details.

## Common mistakes and limitations

- Rerunning the complete batch immediately.
- Treating visible titles as complete records.
- Changing mapping and source at once.
- Deleting partial records before reconciliation.
- Retrying duplicate-risk records.
- Sending credentials with a support log.
- Calling an unexplained count difference harmless.

Import capabilities vary by source and destination. Use current supported export and import routes only.

## Frequently asked questions

### Should I delete the partial import first?

Not before capturing the destination baseline and understanding rollback. Deletion can erase evidence and may remove valid accepted records.

### Can I retry only failed records?

Yes when the tool supports a clean subset and you have confirmed which records failed. Test a small subset and reconcile again.

### What if no import log exists?

Preserve screenshots and states, compare source and destination inventories, use representative control records, and seek current support before broad retries.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [National Archives: Records inventory introduction](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [Norva support](https://norva.tv/support)
