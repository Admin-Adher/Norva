---
content_id: "NVB-115"
title: "Set Metadata Rules Before a Large Library Import"
seo_title: "Set Metadata Rules Before Library Import"
meta_description: "Set media metadata rules before import by defining fields, sources of truth, labels, unknown states, version relationships, validation, and rollback."
slug: "plan-metadata-rules-before-import"
canonical_url: "https://norva.tv/blog/plan-metadata-rules-before-import/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Collection Planning"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Which metadata rules should be set before a large media library import?"
supporting_questions:
  - "How should unknown and conflicting values be handled?"
  - "Which fields are worth maintaining?"
audience:
  - "People preparing a large media import"
  - "Households standardising catalogue metadata"
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
estimated_reading_minutes: 7
excerpt: "Pre-import metadata rules define the minimum useful fields, authoritative source, allowed values, unknown states, relationships, validation, and exception handling."
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
  - "/blog/set-library-findability-goals/"
  - "/blog/plan-library-migration/"
  - "/blog/create-library-decision-log/"
cta:
  label: "Explore Norva's Organization Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.archives.gov/files/preservation/formats/pdf/naming-and-organizing-files.pdf"
  - "https://www.loc.gov/preservation/resources/rfs/index.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "pre-import metadata rulebook"
  summary: "A field-by-field rulebook records purpose, source of truth, allowed values, null handling, conflict rules, and validation examples."
  methodology: "Readers test the rules on representative normal, multilingual, multi-version, missing-data, and conflicting-data items before any bulk import."
  asset_urls: []
---

# Set Metadata Rules Before a Large Library Import

> **In short:** Define each required field, why it exists, which source is authoritative, allowed values, how unknowns are represented, and how conflicts are handled. Include version and part relationships, language distinctions, and validation examples. Test the rules on difficult items before importing a large batch, and route exceptions instead of guessing.

An import scales both good and bad decisions. Ten ambiguous labels can be reviewed manually; thousands of inconsistent transformations can become another migration.

## Begin with retrieval needs

Every required field should support at least one task:

- identify the correct work;
- distinguish an exact version;
- browse by media type or category;
- find an episode or part;
- filter by language metadata;
- understand source and availability;
- retain relevant rights or ownership context;
- support archive or maintenance decisions.

If a field has no user or maintenance purpose, leave it optional or omit it. Start from [the findability goals](/blog/set-library-findability-goals/).

## Define a minimum field set

A practical starting set may include:

- stable item or source identifier;
- display title;
- media type;
- date or year where meaningful;
- source;
- work/version relationship;
- season, episode, or part relationship;
- descriptive language;
- available audio and subtitle metadata when exposed;
- availability state;
- archive or review state;
- last verified date.

This is a planning example, not a universal schema. Dublin Core publishes terms such as title, type, date, source, relation, language, rights, and identifier. Use its definitions as references while tailoring the implementation to actual tools.

## Choose a source of truth per field

For each field, identify:

1. primary source;
2. acceptable fallback;
3. person or process allowed to override it;
4. evidence required for override;
5. review trigger.

Do not call the longest or most detailed value authoritative automatically. Source data may conflict, and a household correction needs a documented reason.

## Preserve unknown and conflicting states

Allow:

- unknown;
- absent from source;
- not applicable;
- multiple values;
- conflict requiring review;
- value inferred but unverified, if the system clearly distinguishes it.

Never replace missing data with a plausible guess merely to satisfy a mandatory column. An exception queue is safer than false completeness.

## Define relationships explicitly

Separate:

- work and version;
- series and episode;
- collection and member;
- original and alternative title;
- source item and local organisational record;
- active and archive state.

Dublin Core includes relationship terms such as `hasPart`, `isPartOf`, `hasVersion`, and `isVersionOf`. A tool may represent these differently, but the conceptual distinction prevents flat duplicate records.

## Standardise labels cautiously

Choose controlled labels for media type, category, language, and availability. Keep a mapping table from source values to destination values.

NARA's file-naming guidance recommends consistent, human-readable, machine-friendly patterns. If actual files are involved, follow the current source, operating-system, and format requirements. Do not rename file extensions or move source-managed media merely to match catalogue labels.

## Validate difficult cases before import

Test at least:

- a normal complete item;
- missing date or title detail;
- duplicate title across sources;
- multi-version work;
- multilingual item;
- episode with incomplete numbering;
- unavailable item;
- archive candidate;
- conflict between two source values.

Use [the migration plan](/blog/plan-library-migration/) to separate mapping, exceptions, reconciliation, and cutover.

## Original evidence: metadata rulebook

| Field | Purpose | Source of truth | Allowed/unknown values | Conflict rule | Test case |
| --- | --- | --- | --- | --- | --- |
| Title |  |  |  |  |  |
| Type |  |  |  |  |  |
| Source |  |  |  |  |  |
| Version relation |  |  |  |  |  |
| Language |  |  |  |  |  |
| Availability |  |  |  |  |  |

Version the rulebook and record exceptions in [the library decision log](/blog/create-library-decision-log/). Import only the representative pilot until every essential field produces understandable results.

## Common mistakes and limitations

- Making every possible field mandatory.
- Guessing unknown values.
- Using one language field for title, audio, and subtitles.
- Flattening versions into apparent duplicates.
- Renaming source-managed files without support.
- Changing mappings during a batch without versioning the rules.
- Treating a standard vocabulary as a complete household workflow.

Norva can group variants and organise source metadata, but the connected source determines what data and media are exposed. Missing source information cannot be guaranteed to appear after import.

## Frequently asked questions

### Should filenames contain all metadata?

No. Filenames should remain stable and compatible when files are under your management. Rich descriptive data usually belongs in catalogue fields when the system supports them.

### How should conflicts be resolved?

Choose a documented source of truth, preserve the competing value when useful, and send uncertain cases to review. Never overwrite silently.

### Can rules change after import?

Yes, but version the change, estimate affected records, test a reversible batch, and record the reason before applying it broadly.

## Your next step

[Explore Norva's organization features](https://norva.tv/#features)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [National Archives: Naming and organising files](https://www.archives.gov/files/preservation/formats/pdf/naming-and-organizing-files.pdf)
- [Library of Congress: Recommended Formats Statement](https://www.loc.gov/preservation/resources/rfs/index.html)
- [Norva features](https://norva.tv/#features)
