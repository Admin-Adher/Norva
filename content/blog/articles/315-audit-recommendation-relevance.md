---
content_id: "NVB-315"
title: "How to Audit the Relevance of Related-Title Suggestions"
seo_title: "Audit the Relevance of Related-Title Suggestions"
meta_description: "Audit related-title relevance with a declared brief, representative seeds, visible metadata evidence, readiness checks, reproducible labels, limitations, and follow-up actions."
slug: "audit-recommendation-relevance"
canonical_url: "https://norva.tv/blog/audit-recommendation-relevance/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "audit guide"
topic_cluster: "Recommendations & Discovery"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can viewers audit the relevance of related-title suggestions?"
supporting_questions:
  - "Which sample and labels make a relevance review reproducible?"
  - "How should metadata and availability limits be reported?"
audience:
  - "Norva users reviewing discovery quality"
  - "Editors documenting recommendation behavior"
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
estimated_reading_minutes: 8
excerpt: "A transparent relevance audit that evaluates visible relationships and viewing readiness without inferring hidden recommendation logic or publishing weak percentages."
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
parent_pillar: "/blog/recommendations-discovery-guide/"
related_articles:
  - "/blog/evaluate-why-titles-seem-related/"
  - "/blog/evaluate-irrelevant-recommendation/"
  - "/blog/recommendations-with-incomplete-metadata/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.eidr.org/how-we-work"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "related-title relevance audit protocol"
  summary: "A multi-seed protocol labels relationship evidence, brief fit, version readiness, metadata completeness, and exception type with independent review."
  methodology: "Reviewers declare scope, choose varied non-sensitive seeds, cap suggestions equally, classify visible evidence using written rules, reconcile disagreements, and report counts only with sample limits."
  asset_urls: []
---

# How to Audit the Relevance of Related-Title Suggestions

> **In short:** Define relevance before collecting suggestions. Choose a small, varied set of verified seeds, inspect the same number of related cards for each, and label visible relationship evidence, brief fit, version readiness, and metadata completeness. Reconcile reviewer disagreements and report sample limits. Do not infer hidden weighting or publish a universal quality score from one library.

A useful audit replaces “these feel random” with transparent categories. Its purpose is to identify actionable patterns—strong relationships, sparse metadata, version problems, repetitive loops, or unavailable candidates.

## Declare scope and relevance rules

Record date, product version if visible, account and neutral profile label, supported screen, connected source context, filters, and seed selection method. Define relevant as:

> At least one visible, verified relationship answers the stated discovery brief, and the candidate’s work identity is clear.

Keep version readiness separate. An unavailable edition can be relevant but not ready.

## Choose a representative seed set

Include varied media types, periods, subjects, series relationships, and metadata completeness where the source contains them. Avoid selecting only favourite titles or known failure cases. Use a small sample the reviewer can inspect carefully.

Do not advertise the sample as statistically representative without a sampling design. It is a structured diagnostic.

## Use a written classification rubric

| Dimension | Labels |
|---|---|
| Relationship evidence | Strong / limited / unknown |
| Brief fit | Fits / partial / does not fit |
| Version readiness | Ready / unsuitable / unavailable / unknown |
| Metadata | Sufficient / incomplete / conflicting |
| Path pattern | Diverse / repetitive / not assessed |

Use [the two-title evaluation card](/blog/evaluate-why-titles-seem-related/) for the relationship label. DCMI and EIDR provide field and hierarchy concepts; they do not reveal Norva’s internal logic.

## Collect one bounded sample

For each seed, record the first agreed number of visible suggestions under the same interface state. Capture exact titles and fields, not row screenshots alone. Do not play candidates unless version identity cannot otherwise be confirmed.

If metadata is incomplete, apply [the missing-field diagnostic](/blog/recommendations-with-incomplete-metadata/). If a card is irrelevant, use [the irrelevant-recommendation analysis](/blog/evaluate-irrelevant-recommendation/) rather than forcing a relation.

## Add independent review

Have a second reviewer classify a subset without seeing the first labels. Compare disagreements by dimension. A difference about “brief fit” may reveal an unclear brief; a difference about “relationship evidence” may reveal missing metadata.

Resolve by citing visible fields, not by averaging opinions. Preserve unresolved cases as Unknown.

## Report findings responsibly

Report counts with the number of seeds, cards, source context, date, and limitations. Prefer statements such as “four of fifteen sampled cards had no visible relation under this rubric” over “recommendations are 73% accurate.” The latter invents generality and precision the sample does not support.

Separate actions:

- improve or verify source metadata through an authorised workflow;
- change an overly narrow seed;
- compare another discovery route;
- verify a version;
- document a persistent current-product issue for support.

Preserve a dated audit version with the exact rubric and seed list. When repeating the review, change neither labels nor sample rules silently. If the product, source, or metadata changed, record that context and treat the new run as a comparison under different conditions rather than a direct performance trend.

## Original evidence: audit protocol

Run the rubric across at least two meaningfully different seeds and one control seed with complete metadata. Preserve the anonymised table and disagreement notes. Another reviewer should be able to reproduce labels from the rules.

The protocol creates an auditable sample. It cannot rank products, establish causal algorithms, or guarantee future behavior.

## Common mistakes and limitations

- Defining relevance after seeing suggestions.
- Selecting only favourite or problematic seeds.
- Mixing work relevance with playback readiness.
- Inferring weighting from row position.
- Publishing percentages without sample context.
- Correcting metadata to improve the audit result.

## Frequently asked questions

### How many seeds are enough?

Use the smallest varied sample that answers the diagnostic question. Do not claim representativeness without a formal design.

### Should reviewers know the seed title?

Yes, because relationship evaluation requires it. They should not see each other’s labels before independent classification.

### What should happen after the audit?

Prioritise the most repeated actionable pattern, make one verified change, and rerun a comparable sample later.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [Norva Support](https://norva.tv/support)
