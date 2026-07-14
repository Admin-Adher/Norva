---
content_id: "NVB-155"
title: "Why Source Identifiers Matter in a Metadata Audit"
seo_title: "Why Media Source Identifiers Matter in Audits"
meta_description: "Audit media source identifiers by preserving namespace, value, source, record scope, stability, collisions, redirects, version relationships, and migration mappings."
slug: "audit-media-source-identifiers"
canonical_url: "https://norva.tv/blog/audit-media-source-identifiers/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "concept-explainer"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Why do source identifiers matter in a media metadata audit?"
supporting_questions:
  - "What makes a source identifier usable and safe to compare?"
  - "How should identifier collisions and migration mappings be investigated?"
audience:
  - "People auditing media identity metadata"
  - "Catalogue maintainers planning source migrations or deduplication"
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
excerpt: "A source identifier is useful only with its namespace, scope, provenance, stability assumptions, and mapping history; a bare value can create false matches."
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
  - "/blog/media-metadata-quality-audit/"
  - "/blog/resolve-conflicting-release-years/"
  - "/blog/check-person-credit-consistency/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "consideration"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "identifier namespace and continuity register"
  summary: "A register records identifier namespace, value, issuing source, entity type, version scope, first and last seen dates, redirects, collisions, and migration mappings."
  methodology: "Readers inventory identifiers, test uniqueness within scope, cross-check identity fields, classify collisions and changes, and preserve old-to-new mappings through observation."
  asset_urls: []
---

# Why Source Identifiers Matter in a Metadata Audit

> **In short:** Titles, posters, and years can change or collide; a well-scoped source identifier helps maintain continuity. Store the namespace, value, issuing source, entity type, edition or version scope, and mapping history together. Test uniqueness only inside the declared namespace, and never merge records from matching bare numbers without confirming identity and provenance.

An identifier is not automatically global, permanent, or correct. The same value can be issued by different systems, reused for different entity types, or replaced during a migration.

## Understand the identifier claim

Every identifier should answer:

- **Namespace:** which system or scheme defines the value?
- **Issuer/source:** who supplied it to this record?
- **Entity type:** work, film edition, series, season, episode, person, source asset, or track?
- **Scope:** global, source account, collection, or import batch?
- **Version:** does it identify the abstract work or a specific media variant?
- **Lifecycle:** can it redirect, be replaced, or disappear?

Dublin Core defines identifier as an unambiguous reference to a resource within a given context. “Within a given context” is essential: the value without its namespace is incomplete.

## Build the identifier namespace and continuity register

Create one row per identifier claim:

| Namespace | Value | Issuer | Entity/scope | Source record | First seen | Last verified | Redirect/replacement | Collision status |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

Keep identifiers as strings. Leading zeros, separators, and case may be meaningful. Do not convert a value to a number merely because it contains digits.

## Run four identifier tests

### 1. Syntax

Does the value follow the namespace’s documented form? Syntax catches truncation, whitespace, illegal characters, and transformation errors, but cannot prove the identifier belongs to the work.

### 2. Uniqueness

Within the declared namespace and entity type, do several active records share the value? A collision may indicate grouped versions, a duplicate import, an incorrect mapping, or a source rule that identifies works rather than assets.

### 3. Referential identity

Do title, creators, year, runtime, series relationship, and source evidence support the same entity? If the identifier points to one work while the poster and synopsis describe another, identity repair takes priority.

### 4. Continuity

Did the value persist through refresh, media replacement, or migration? If it changed, is an old-to-new mapping documented and tested?

## Classify anomalies

- missing namespace;
- malformed or truncated value;
- duplicate value within an incompatible entity scope;
- same work represented by several legitimate version identifiers;
- one identifier incorrectly attached to different works;
- identifier replaced without continuity mapping;
- stale reference after source removal;
- source exposes no stable identifier;
- unresolved semantics.

Do not deduplicate on identifier alone until you know whether it identifies a work or a version. Conversely, different source identifiers do not prove that records represent different works.

## Use identifiers in broader audits

Start [the metadata quality audit](/blog/media-metadata-quality-audit/) with identifier coverage and collisions. Use identifiers to support—but not replace—the evidence in [release-year investigations](/blog/resolve-conflicting-release-years/) and [person-credit consistency checks](/blog/check-person-credit-consistency/).

For a migration, preserve a crosswalk:

| Old namespace/value | New namespace/value | Entity confirmed by | Mapping status | Rollback reference |
|---|---|---|---|---|
|  |  |  |  |  |

Keep the crosswalk until representative records, personal context, search, groups, and refresh behaviour pass. The Library of Congress inventory guidance emphasises maintaining knowledge of collection content and custody; continuity mappings serve that purpose during change.

## Protect identifiers during correction

Treat identifiers as evidence-bearing fields. Limit manual edits, record transformations, retain the original value, and validate import/export round trips. Avoid exposing internal account or security-sensitive identifiers unnecessarily.

Norva can organise compatible authorised sources, but identifier availability, stability, and semantics depend on those sources. Ask support when a control’s scope is unclear.

## Common mistakes and limitations

- Comparing bare values without namespaces.
- Converting identifiers to numbers.
- Assuming uniqueness is global.
- Merging work and version identifiers.
- Dropping old identifiers immediately after migration.
- Treating a valid format as proof of identity.

Some sources provide no stable identifier or document none. Use a transparent composite evidence process and mark confidence accordingly rather than inventing one.

## Frequently asked questions

### Is a filename a source identifier?

It can be a local locator, but names can change and collide. Record it as such and do not grant it unverified permanence or global scope.

### Can two versions share one work identifier?

Yes, when the namespace identifies the abstract work. They should still retain distinct source or version references where available.

### What if an identifier changes after refresh?

Capture old and new values, confirm the entity through independent fields, determine whether the source replaced or redirected the record, and preserve the mapping before further cleanup.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva Support](https://norva.tv/support)
