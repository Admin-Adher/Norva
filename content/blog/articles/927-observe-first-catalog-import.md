---
content_id: "NVB-927"
title: "What to Observe During Your First Catalog Import"
seo_title: "Observe Your First Norva Catalog Import"
meta_description: "Monitor a first Norva catalog import by recording scope, timing, visible progress, sample organization, exceptions, and a clear completion decision."
slug: "observe-first-catalog-import"
canonical_url: "https://norva.tv/blog/observe-first-catalog-import/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "catalog-import-observation-guide"
topic_cluster: "Norva Onboarding"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What should I observe during my first Norva catalog import?"
supporting_questions:
  - "Which import signals are useful without exposing private catalog data?"
  - "How can I distinguish progress, delay, and a confirmed failure?"
audience:
  - "New Norva users"
  - "Household media administrators"
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
excerpt: "Observe scope, timing, progress, sample organization, and exceptions during a first catalog import without recording private source details."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/norva-onboarding-complete-journey/"
related_articles:
  - "/blog/norva-onboarding-complete-journey/"
  - "/blog/connect-first-authorized-source-checklist/"
  - "/blog/verify-first-catalog-sample/"
cta:
  label: "Review Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "catalog import observation timeline"
  summary: "A timestamped observation log records declared scope, visible state changes, sample availability, exceptions, and the decision to wait, verify, or escalate."
  methodology: "The observer uses fixed checkpoints, records only sanitized interface evidence, and avoids restarting the import until the observed state supports that action."
  asset_urls: []
---

# What to Observe During Your First Catalog Import

> **In short:** During a first Norva catalog import, record the expected scope, start time, visible status changes, when recognizable items appear, and any sanitized error. Do not judge quality from the first item alone, and do not restart simply because the interface pauses briefly. Finish with a small catalog sample check and a clear decision: complete, still progressing, or needs investigation.

A first import establishes the baseline for later refreshes and troubleshooting. The goal is not to watch every item arrive. It is to collect enough structured evidence to know whether the source connection and resulting organization behave plausibly.

Complete the [authorized-source connection checklist](/blog/connect-first-authorized-source-checklist/) first. An import observation cannot resolve uncertain source rights or unsafe credential handling.

## Define the expected scope

Before starting, describe the source in broad terms: expected movies, series, or both; approximate scale if known; and one or two recognizable examples. Do not copy a private source address or full catalog into the log.

The estimate is a comparison aid, not a promise. Source data, connectivity, device resources, and current product behavior can affect what appears and when.

## Record the starting conditions

Note the date, local time, Norva surface, device category, network context, and active profile. Record whether this is a first connection or a repeat attempt. These details allow a later test to reproduce the same conditions.

The [complete onboarding journey](/blog/norva-onboarding-complete-journey/) helps place this observation after account, profile, and source preparation instead of mixing all setup stages together.

## Watch state changes, not animations

An animation only shows that the interface is active; it does not prove server or source progress. Prefer meaningful signals: a status label changes, an item count appears, a recognizable title becomes visible, or the interface displays a completion or error state.

Record the first occurrence of each signal with a timestamp. Avoid refreshing, reconnecting, or navigating away during every quiet interval. Those actions can interrupt the very process being observed.

## Sample early results carefully

When items begin to appear, inspect a few known examples across relevant types. Check whether a movie looks like a movie, a series is grouped as a series, and episodes appear in a plausible order. Early partial results do not establish final completeness.

Norva organizes a catalog and may group variants from source-derived information. It cannot create missing source metadata, language tracks, artwork, or rights. Treat a questionable result as an observation to verify, not immediate proof of a product defect.

## Separate delay from failure

A delay is a period without a new visible signal. A failure needs stronger evidence, such as an explicit error, a documented timeout in current official guidance, or a reproducible inability to proceed. Without that evidence, classify the state as unknown or still under observation.

If a message appears, record its sanitized wording and stage. Do not include credentials, tokens, private source addresses, or unnecessary titles in a screenshot.

## End with a verification sample

After a completion signal or a stable result, use the [first catalog sample procedure](/blog/verify-first-catalog-sample/). Catalog import and catalog verification are separate: the first observes the process; the second tests whether representative results are organized usefully.

Do not equate an exact item count with quality. Counts can be affected by grouped versions, source changes, filters, and current presentation rules.

## Original evidence: import observation timeline

| Checkpoint | Time | Sanitized signal | Interpretation | Next decision |
| --- | --- | --- | --- | --- |
| Start |  | Import initiated | Baseline | Observe |
| First state change |  |  | Progress / Unknown | Observe |
| First known item |  |  | Partial result | Sample |
| Stable state |  |  | Complete / Delayed / Failed | Verify / Wait / Investigate |

Keep interpretations separate from observed signals. "No change for five minutes" is evidence; "the import is broken" is a conclusion that requires more support.

## Common observation errors

- Restarting before recording the current state.
- Treating motion as proof of import progress.
- Exposing private catalog or connection details in screenshots.
- Comparing counts while filters or grouping differ.
- Declaring completeness from one recognizable title.
- Changing the source and network during the same test.

## Frequently asked questions

### How long should a first import take?

There is no universal duration. Scope, source response, connectivity, device conditions, and current implementation can differ. Use visible state changes and current official support guidance rather than an invented deadline.

### Does the first visible item mean the import is complete?

No. It only proves that at least part of the result is visible. Wait for a stable or explicit state, then verify a representative sample.

### Should I record every catalog title?

No. Use a few non-sensitive examples and minimize private data. The observation log should explain process behavior, not duplicate the household catalog.

## Your next step

[Review Norva Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
