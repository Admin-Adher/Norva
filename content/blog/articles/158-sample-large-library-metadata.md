---
content_id: "NVB-158"
title: "How to Sample Metadata Quality in a Large Library"
seo_title: "Sample Metadata Quality in a Large Media Library"
meta_description: "Sample large-library metadata with a documented frame, risk strata, random selection within strata, boundary cases, known controls, weighted findings, and limits."
slug: "sample-large-library-metadata"
canonical_url: "https://norva.tv/blog/sample-large-library-metadata/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-framework"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should metadata quality be sampled in a large media library?"
supporting_questions:
  - "How can every important source and risk class be represented?"
  - "How should sample findings be interpreted without overclaiming?"
audience:
  - "People auditing large personal media catalogues"
  - "Catalogue maintainers designing repeatable quality samples"
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
excerpt: "A useful large-library sample combines random selection within declared strata with deliberate edge cases and reports both separately."
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
  - "/blog/prioritize-metadata-corrections/"
  - "/blog/metadata-quality-control-checklist/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "consideration"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "two-lane stratified metadata sample"
  summary: "A sample design separates inference-oriented random records within source and risk strata from diagnostic edge cases that must not be used to estimate prevalence."
  methodology: "Readers define a complete sampling frame, stratify by source and record context, select reproducibly, audit with one rubric, weight prevalence carefully, and publish limitations."
  asset_urls: []
---

# How to Sample Metadata Quality in a Large Library

> **In short:** Build a complete sampling frame, divide it into meaningful strata such as source, record type, recency, language, and version complexity, then select records randomly within each stratum. Maintain a second diagnostic lane for known errors and edge cases. Use the random lane to estimate patterns; use the diagnostic lane to discover causes. Never combine them into one headline defect rate.

Checking only popular titles, the first screen, or known complaints produces useful examples but a biased picture of the catalogue.

## Define the sampling frame

The frame is the list from which records can actually be selected. Record:

- catalogue and source scope;
- snapshot date and mapping version;
- included record types;
- excluded and unreachable records;
- stable selection identifier;
- total count by source and type;
- known coverage limitations.

If orphaned or failed-import records are absent from the frame, say so. The National Archives describes inventory as systematic information gathering; a documented frame is the foundation of a defensible sample.

## Choose strata that affect quality

Useful strata include:

- connected source or import route;
- film, series, season, episode, special, or version;
- recently added versus long-standing;
- original versus migrated record;
- single-language versus multilingual;
- single version versus grouped versions;
- complete versus visibly incomplete metadata;
- frequently used versus rarely opened.

Do not create so many combinations that each contains one item. Use a few dimensions tied to plausible error causes and user tasks.

## Use two separate lanes

### Lane A: inference sample

Select records randomly or with a reproducible interval inside each stratum. This lane supports statements about observed defect patterns within the frame.

### Lane B: diagnostic sample

Deliberately include known bad records, boundary cases, rare scripts, conflicting years, specials, multi-role credits, and unusual version groups. This lane tests whether the audit rubric detects important problems and helps investigate causes.

Never use Lane B to estimate the catalogue-wide error rate because its records were selected for risk.

## Build the sample register

| Sample ID | Lane | Stratum | Selection method | Record ID | Replacement reason | Reviewer | Result |
|---|---|---|---|---|---|---|---|
|  | A/B |  | random/interval/deliberate |  |  |  |  |

Generate selection from stable identifiers and preserve the random seed or interval where possible. Do not quietly replace a difficult record with an easier one. Record ineligible or inaccessible selections and use a predefined replacement rule.

## Decide sample size pragmatically

There is no universal personal-library number. Choose enough records to represent every important stratum and detect recurring operational causes, while keeping manual verification credible.

Start with a pilot of a few records per stratum to measure review time and defect variability. Expand strata with high consequence, high variation, recent change, or uncertain source behaviour. Audit all records when the population is small or the contemplated action is destructive.

Avoid precise confidence claims unless a qualified analyst has designed the sample and the frame supports them. Report observed counts, proportions, scope, and limitations in plain language.

## Apply one audit rubric

Use the same field definitions and severity rules in both lanes. Cover identity, completeness, validity, consistency, accuracy, provenance, and recency through [the metadata quality audit](/blog/media-metadata-quality-audit/).

Double-review a subset, especially identity and language cases. Record disagreement rather than forcing instant consensus; reviewer variation is itself a quality signal.

## Interpret findings correctly

Within each stratum, report reviewed count, defects by severity and field, and recurring cause. For an overall estimate, weight stratum results by their share of the frame rather than simply averaging percentages.

Keep diagnostic findings separate: “8 of 20 targeted edge cases exposed a version-mapping defect” is useful, but it is not “40% of the library is wrong.”

Route causes through [the correction-priority process](/blog/prioritize-metadata-corrections/) and validate a repaired batch with [the quality-control checklist](/blog/metadata-quality-control-checklist/).

Norva can organise compatible authorised sources, but available metadata and export or filtering controls may vary.

## Common mistakes and limitations

- Sampling the first page of results.
- Mixing random and complaint-driven records.
- Excluding unreachable records without reporting them.
- Replacing inconvenient selections silently.
- Averaging unequal strata without weights.
- Claiming statistical certainty from a convenience sample.

Sampling can miss rare but severe defects. Maintain rule-based checks and complaint routes alongside periodic samples.

## Frequently asked questions

### Should every source receive the same sample count?

Give every important source representation, then allocate more review to large, volatile, or high-risk strata. Report the allocation so findings are interpretable.

### Can I sample by title alphabetically?

A fixed interval over a stable sorted frame can be reproducible, but alphabetic patterns may correlate with language or source. Random selection within strata is usually safer.

### What if the catalogue changes during sampling?

Freeze a snapshot or record additions, removals, and mapping changes. If change materially alters the frame, close the sample and start a new version.

## Your next step

[See how Norva works](https://norva.tv/#how-it-works)

## Sources

- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva: How it works](https://norva.tv/#how-it-works)
