---
content_id: "NVB-141"
title: "How to Run a Media Metadata Quality Audit"
seo_title: "Run a Media Metadata Quality Audit"
meta_description: "Audit media metadata by defining user tasks, critical fields, quality dimensions, representative samples, defect severity, provenance, ownership, and retests."
slug: "media-metadata-quality-audit"
canonical_url: "https://norva.tv/blog/media-metadata-quality-audit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "pillar-guide"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How do I run a media metadata quality audit?"
supporting_questions:
  - "Which metadata fields and quality dimensions should be checked?"
  - "How should defects be sampled, prioritised, and retested?"
audience:
  - "People responsible for a personal media catalogue"
  - "Households diagnosing confusing catalogue metadata"
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
excerpt: "A useful metadata audit tests whether catalogue information supports identity, retrieval, choice, relationships, and accessibility—not whether every field is filled."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/normalize-media-title-capitalization/"
  - "/blog/resolve-conflicting-release-years/"
  - "/blog/audit-audio-language-metadata/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "field-use-risk metadata audit matrix"
  summary: "A matrix links each metadata field to a user task, quality dimensions, consequence, evidence source, sample rule, owner, and retest."
  methodology: "Readers define audit scope, stratify samples, evaluate completeness, validity, consistency, accuracy, provenance, and timeliness, then prioritise defects by user consequence."
  asset_urls: []
---

# How to Run a Media Metadata Quality Audit

> **In short:** Start from the tasks metadata must support: identifying a work, finding it, distinguishing variants, following series order, and choosing language or accessibility options. Map critical fields to those tasks, sample across sources and edge cases, then evaluate completeness, validity, consistency, accuracy, provenance, and timeliness. Prioritise defects by user consequence and retest corrections through the real interface.

An audit is not a search for blank fields. A populated year can be wrong, a precise language label can describe the wrong track, and a beautiful poster can belong to another work.

## Define scope and decisions

Write the catalogue, sources, date, profiles, record types, and supported views in scope. State the decisions the audit must enable, such as correcting a source mapping, standardising labels, or deciding whether a migration is ready to close.

List the user tasks that matter:

- search for a known title;
- distinguish works with similar names;
- browse by category or genre;
- select the intended version;
- follow season and episode order;
- identify audio and subtitle options;
- resume the correct record.

Metadata unrelated to a task can be lower priority. This keeps the audit focused on usability rather than maximum field count.

## Build the field-use-risk matrix

Complete one row per critical field:

| Field | User task | Quality dimensions | Failure consequence | Evidence source | Sample | Owner |
|---|---|---|---|---|---|---|
| Title | Identity, search | Accuracy, consistency | Wrong or missed result | Source reference |  |  |
| Year/date | Identity | Accuracy, validity | Versions confused | Authoritative record |  |  |
| Series/episode | Navigation | Completeness, relationship | Wrong order or orphan | Source hierarchy |  |  |
| Audio/subtitle | Choice | Accuracy, vocabulary | Wrong expectation | Actual selectable track |  |  |
| Poster/synopsis | Recognition | Accuracy, provenance | Wrong work selected | Work identity |  |  |

Dublin Core defines terms such as title, identifier, language, relation, subject, and issued date. Its model is useful for clarifying what a field claims, even when a personal catalogue uses different names.

## Apply six quality dimensions

Evaluate each sampled field:

1. **Completeness:** required information is present when the source makes it available.
2. **Validity:** value follows the expected type, vocabulary, or format.
3. **Consistency:** equivalent concepts use compatible forms across the defined scope.
4. **Accuracy:** value describes the actual work, edition, episode, or track.
5. **Provenance:** origin and transformation of the value can be understood.
6. **Timeliness:** value reflects the currently connected record or mapping.

“Unknown” can be valid and honest. A guessed value may look complete while reducing accuracy.

## Design a representative sample

Use stratified sampling rather than only the first screen. Include:

- every connected source or import route;
- films and series;
- new, old, and recently changed records;
- multilingual and multi-version items;
- records with missing fields;
- boundary cases such as specials and remakes;
- items used by different profiles;
- known good records as controls.

Audit all records for fields that can be checked safely by rule, then manually review representative successes and every exception. The National Archives describes inventory as a systematic information-gathering process; documenting scope and sample prevents the audit from becoming anecdotal.

## Record defects by consequence

Use four severity levels:

- **Critical:** wrong-item playback, destructive misidentification, or a severe accessibility choice error.
- **High:** essential search, series order, or version selection fails.
- **Medium:** browse or recognition is confusing but a reliable route remains.
- **Low:** harmless style inconsistency with no material task impact.

For each defect, record field, current value, expected value or uncertainty, evidence, source, scope, cause hypothesis, action, owner, and retest date. Separate source defects from local mapping or presentation defects.

## Correct causes in small batches

Do not hand-edit hundreds of symptoms before learning the pattern. Pilot one coherent cause and preserve the baseline. Use the dedicated workflows for [title capitalisation](/blog/normalize-media-title-capitalization/), [conflicting release years](/blog/resolve-conflicting-release-years/), and [audio-language metadata](/blog/audit-audio-language-metadata/).

After correction, repeat the original user task on representative and boundary records. Refresh a second supported view when relevant. Norva can organise metadata from compatible authorised sources, but available information and actual tracks depend on the source and media.

## Publish an audit summary

Report scope, sample, quality dimension, defect count by severity, top causes, corrected batch, unresolved risks, owner, and next audit trigger. Avoid one overall “quality score” unless weighting and limitations are explicit; it can hide a critical identity failure beneath many complete fields.

## Common mistakes and limitations

- Measuring completeness only.
- Treating source values as automatically correct.
- Sampling only popular or recent items.
- Correcting presentation before identity.
- Guessing unavailable metadata.
- Reporting defects without provenance or ownership.

A sample estimates patterns but does not prove the entire catalogue correct. Increase coverage for destructive decisions or heterogeneous sources.

## Frequently asked questions

### How often should a metadata audit run?

Run one after a major import, migration, or source change, and when recurring defects appear. Use smaller rotating checks during routine maintenance.

### Is artwork metadata?

Yes in the broad catalogue sense: it is descriptive and supports recognition. Audit its relationship to the work, source, and rights, not just image resolution.

### Should missing values be filled manually?

Only when a supported workflow and reliable evidence exist. Preserve uncertainty rather than inventing precision that future reviewers cannot trace.

## Your next step

[Explore Norva's features](https://norva.tv/#features)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Norva features](https://norva.tv/#features)
