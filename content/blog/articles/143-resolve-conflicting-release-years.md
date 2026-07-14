---
content_id: "NVB-143"
title: "How to Investigate Conflicting Release Years"
seo_title: "Investigate Conflicting Media Release Years"
meta_description: "Investigate conflicting release years by defining each claim, confirming work and edition identity, ranking evidence, recording provenance, and preserving uncertainty."
slug: "resolve-conflicting-release-years"
canonical_url: "https://norva.tv/blog/resolve-conflicting-release-years/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should conflicting release years in a media catalogue be investigated?"
supporting_questions:
  - "Why can valid dates differ for the same title?"
  - "How should evidence and uncertainty be recorded?"
audience:
  - "People resolving media date conflicts"
  - "Catalogue maintainers distinguishing works and editions"
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
excerpt: "Conflicting years often describe different events, territories, editions, or records, so the first task is to define what each date actually claims."
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
  - "/blog/review-old-version-groups/"
  - "/blog/normalize-media-title-capitalization/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "date-claim evidence ledger"
  summary: "A ledger records every candidate date as a specific event claim with territory, edition, source, stable identifier, evidence strength, and uncertainty."
  methodology: "Readers confirm identity, separate creation, premiere, publication, regional availability, edition, and source dates, then select or retain values according to a documented field policy."
  asset_urls: []
---

# How to Investigate Conflicting Release Years

> **In short:** A year is not meaningful until you know which event it represents. Confirm that the records describe the same work and edition, then separate creation, premiere, first public release, regional release, broadcast, physical edition, restoration, and source-added dates. Record provenance for every candidate, apply a written field policy, and preserve uncertainty instead of choosing the most common value.

Two credible sources can show different years without either being careless. A film may premiere at a festival in one year and receive a general release in another; a series episode may air in different territories across a boundary.

## Confirm identity before dates

Compare stable identifiers where available, title, creators, cast, runtime, edition wording, series placement, and synopsis. Similar titles, remakes, restored editions, compilations, and specials can legitimately have different years.

If identity is uncertain, split the investigation. Do not use a preferred year to force two possibly different works into one record or version group.

## Define what the catalogue field means

Write a policy for the displayed “year.” Possibilities include:

- year of first public release of the work;
- first release in a chosen territory;
- original broadcast year;
- publication year of the specific edition;
- source-provided year displayed without transformation.

There is no universally correct choice for every catalogue. Consistency requires a declared claim and a way to handle exceptions.

Dublin Core distinguishes date properties such as created, issued, modified, and available. That vocabulary illustrates why collapsing every event into one unlabeled year creates conflicts.

## Build the date-claim evidence ledger

Record each candidate separately:

| Candidate date | Event claimed | Work/edition | Territory | Source | Stable reference | Evidence strength | Notes |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |

Classify evidence:

1. **Direct authoritative record:** the responsible publisher, broadcaster, archive, or rights-holder identifies the event.
2. **Reliable structured reference:** a recognised catalogue cites a defined date field and matching identifier.
3. **Source metadata:** useful operational evidence whose semantics may be undocumented.
4. **Inference:** filename, poster text, or user memory; retain as a lead, not a conclusion.

Save the access date and exact event wording. A bare URL does not explain why it supports the chosen year.

## Resolve by policy, not majority vote

Apply the declared year policy to the best matching claim. If the catalogue displays the work’s first public release, a later edition date belongs in edition metadata rather than replacing it. If the field represents the connected source record, preserve that provenance and label the limitation.

When evidence remains balanced, mark the year unresolved or retain the source value with a note. Inventing certainty can merge remakes, misorder series, or attach the wrong artwork.

## Test connected fields

A corrected year can affect grouping, sorting, search, posters, and synopsis matching. After a pilot change:

1. search by title and year;
2. compare similarly named works;
3. inspect version groups and editions;
4. confirm poster and synopsis still identify the work;
5. check series order where relevant;
6. refresh another supported view;
7. verify the source does not immediately overwrite the value.

Use [the metadata quality audit](/blog/media-metadata-quality-audit/) to record impact. If the conflict is actually between editions, follow [the version-group review](/blog/review-old-version-groups/). Preserve protected title styling with [the title normalisation workflow](/blog/normalize-media-title-capitalization/).

Norva organises metadata from compatible authorised sources, but source date semantics and refresh behaviour can differ.

## Document the decision

Record the previous value, chosen value, event definition, work and edition identity, evidence, rule applied, affected records, reviewer, and rollback. Keep rejected candidate dates with their reasons; they prevent the same conflict from being reopened without new evidence.

## Common mistakes and limitations

- Picking the earliest year automatically.
- Treating release, broadcast, and edition dates as synonyms.
- Resolving a date before confirming work identity.
- Counting source agreement without comparing provenance.
- Guessing from artwork or filenames.
- Updating the year without checking grouping and poster matches.

Some historical dates remain genuinely uncertain. A documented range or unresolved state may be more accurate than one exact year.

## Frequently asked questions

### Should a festival premiere define the displayed year?

Only if the catalogue policy defines first public premiere that way. Otherwise, store or document it as a separate event when supported.

### What year should a restored edition use?

Keep the original work and restoration or edition dates conceptually separate. Which one is displayed depends on the field policy and record identity.

### Can I trust the year embedded in a filename?

Use it as an investigation lead. Confirm it against identity and a source that defines what the date represents.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva Support](https://norva.tv/support)
