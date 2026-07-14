---
content_id: "NVB-156"
title: "How to Protect Reviewed Metadata From Accidental Overwrites"
seo_title: "Protect Reviewed Metadata From Accidental Overwrites"
meta_description: "Protect reviewed media metadata with field provenance, precedence rules, correction manifests, canary records, change detection, rollback, and post-refresh checks."
slug: "prevent-metadata-correction-overwrites"
canonical_url: "https://norva.tv/blog/prevent-metadata-correction-overwrites/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can reviewed metadata be protected from accidental overwrites?"
supporting_questions:
  - "Which provenance and precedence rules should govern refreshes?"
  - "How can an overwrite be detected and reversed quickly?"
audience:
  - "People maintaining reviewed media metadata"
  - "Catalogue owners preparing refreshes, imports, or migrations"
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
estimated_reading_minutes: 7
excerpt: "Reviewed metadata stays reliable when every field has provenance, precedence, a durable correction record, change detection, and a tested recovery route."
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
parent_pillar: "/blog/media-metadata-quality-audit/"
related_articles:
  - "/blog/audit-media-source-identifiers/"
  - "/blog/review-stale-catalog-metadata/"
  - "/blog/make-catalog-cleanup-reversible/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "reviewed-field correction manifest and canary set"
  summary: "A manifest records original and corrected values, provenance, precedence, review, permitted refresh behaviour, checksum or comparison rule, and rollback for protected fields."
  methodology: "Readers define field precedence, select canary records, snapshot values, run a controlled refresh, compare diffs, and release only expected changes."
  asset_urls: []
---

# How to Protect Reviewed Metadata From Accidental Overwrites

> **In short:** A manual correction is not protected merely because it was reviewed. Record the field’s original and corrected values, provenance, reviewer, date, precedence rule, expected refresh behaviour, and rollback. Before a large import or source refresh, test a canary set of corrected records, compare field-level changes, and stop when a reviewed value changes without an approved rule.

Overwrites often occur because two systems both appear authoritative. A source refresh may restore an old title, a migration may drop a local mapping, or a bulk correction may replace a more specific value with a generic one.

## Map every metadata authority

For each field type, list possible writers:

- connected source;
- local mapping or override;
- migration transform;
- manual review;
- derived or grouped presentation;
- profile-specific preference;
- cache or display layer.

Then define which layer owns the stored value and which may only affect display. Do not let “latest write wins” become an accidental policy.

Dublin Core terms can help distinguish values, sources, identifiers, and relations, but precedence remains a local operational decision that must reflect the actual catalogue workflow.

## Write field-level precedence rules

Use a table:

| Field | Default authority | Reviewed override allowed? | Refresh rule | Conflict action | Owner |
|---|---|---|---|---|---|
| Title |  |  | retain/replace/review |  |  |
| Year |  |  |  |  |  |
| Language |  |  |  |  |  |
| Poster |  |  |  |  |  |
| Series relation |  |  |  |  |  |

Prefer conflict-to-review over silent replacement for identity and accessibility fields. A reviewed value can still become stale, so protection must not mean permanent immunity from new evidence.

## Create the correction manifest

For every protected correction, record:

| Record ID | Field | Original | Corrected | Evidence | Reviewer/date | Rule version | Refresh expectation | Rollback |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

Link records through [audited source identifiers](/blog/audit-media-source-identifiers/) rather than title alone. Preserve old values and their provenance so a future conflict can be evaluated instead of merely reversed.

## Build a canary set

Select a small set that exercises every risky rule:

- manually corrected title and year;
- grouped versions with different source metadata;
- multilingual audio and subtitle labels;
- repaired person credit;
- series relationship correction;
- local artwork or synopsis decision;
- record intentionally left unknown.

The set should contain both protected corrections and ordinary source-owned fields. This reveals whether the refresh respects precedence without freezing legitimate updates.

## Use a controlled refresh gate

Before the event, export or snapshot the canary fields, mapping version, source identifiers, and correction-manifest version. Then:

1. run the smallest supported refresh or import scope;
2. wait for normal processing to finish;
3. create a field-level before-and-after diff;
4. classify each change as expected, beneficial but unplanned, conflict, or regression;
5. verify search, relationships, and personal context;
6. roll back unexplained changes;
7. expand only after the canary passes.

Apply [the reversible-change workflow](/blog/make-catalog-cleanup-reversible/) to high-impact batches.

## Detect silent overwrites

Track a compact fingerprint of reviewed fields where supported: record ID, field name, normalised value, source, rule version, and review date. Compare it after refresh. A checksum can detect change, but the readable values and provenance are needed to decide whether the change is wrong.

Alert on:

- protected field changed by an unapproved writer;
- source identifier replaced without mapping;
- corrected value reverted exactly;
- specific value replaced by blank or generic text;
- correction exists but no longer attaches to the current record;
- one supported view differs after normal refresh.

## Review protection over time

Use [the stale-metadata review](/blog/review-stale-catalog-metadata/) to revalidate old corrections when sources or evidence change. The NDSA Levels of Digital Preservation emphasise fixity, information security, metadata, and documented processes; applying those concepts to correction manifests strengthens change control without claiming permanence.

Norva can organise compatible authorised sources, while refresh and override behaviour may vary. Confirm current supported controls before a major operation.

## Common mistakes and limitations

- Protecting whole records instead of specific reviewed fields.
- Using titles as the only link to a correction.
- Blocking all source updates indefinitely.
- Comparing only the final card appearance.
- Keeping a checksum without readable provenance.
- Expanding after an unexplained canary change.

If a product offers no durable override mechanism, maintain the manifest externally and use it to detect and re-review changes rather than claiming prevention.

## Frequently asked questions

### Should reviewed metadata always override the source?

No. The rule depends on field, evidence, source semantics, and review date. New authoritative evidence may legitimately supersede an older correction.

### How many canary records are enough?

Enough to exercise every risky rule and source path. Coverage of behaviours matters more than a fixed count.

### What if a refresh makes a better change unexpectedly?

Record it as unplanned, verify evidence, update the manifest and precedence rule if appropriate, then retest. Do not accept it silently merely because it looks better.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
