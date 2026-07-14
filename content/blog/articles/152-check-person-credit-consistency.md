---
content_id: "NVB-152"
title: "How to Check Cast and Creator Credit Consistency"
seo_title: "Check Cast and Creator Credit Consistency"
meta_description: "Check cast and creator credits by separating person identity, displayed name, role, character, order, work scope, source provenance, and alternate names."
slug: "check-person-credit-consistency"
canonical_url: "https://norva.tv/blog/check-person-credit-consistency/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should cast and creator credit consistency be checked?"
supporting_questions:
  - "How can a person identity be separated from a displayed name and role?"
  - "How should aliases, credit order, and episode scope be audited?"
audience:
  - "People maintaining cast and creator metadata"
  - "Households searching a catalogue by person"
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
excerpt: "Credit consistency depends on person identity, name form, role, character, order, and work or episode scope—not identical-looking text alone."
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
  - "/blog/find-media-by-person-credits/"
  - "/blog/audit-media-source-identifiers/"
  - "/blog/media-metadata-quality-audit/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "person-credit identity lattice"
  summary: "A lattice links stable person identity, credited name, alternate names, contribution role, character, order, record scope, and source provenance."
  methodology: "Readers sample high-use and ambiguous credits, test identity and scope, classify defects, correct one mapping layer, and verify person-based retrieval."
  asset_urls: []
---

# How to Check Cast and Creator Credit Consistency

> **In short:** Audit credits as relationships between a person and a specific work, version, season, or episode. Keep stable person identity, credited name, alternate names, contribution role, character name, order, and source provenance separate. Merge credits only when identity is verified; split records when identical names refer to different people; and test whether person-based search returns the intended titles.

Credit lists can look inconsistent for legitimate reasons. A person may use a stage name, change name forms across languages, receive a different role on another episode, or be credited only on one version.

## Define what consistency means

Consistency does not mean displaying one name and one role everywhere. It means equivalent claims use the same model and different claims remain distinguishable.

Check these layers:

- **Person identity:** the individual or organisation being credited.
- **Credited name:** the form shown for this work or release.
- **Preferred display name:** the catalogue’s chosen current form, if one is used.
- **Alternate name:** another verified access point.
- **Contribution role:** actor, director, writer, composer, creator, producer, or another defined role.
- **Character or function:** distinct from the contribution role.
- **Scope:** film, series, season, episode, or version.
- **Order:** billing or display position, with provenance.

Dublin Core separates creator and contributor, while allowing names or identifiers to represent responsible entities. That distinction supports a clearer audit even if a source exposes more detailed role terms.

## Build the person-credit identity lattice

Use one row per credit claim:

| Person ID | Credited name | Preferred/alternate form | Role | Character/function | Record scope | Order | Source | Result |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

Do not use the displayed name as the person ID. Names can collide, change, or appear in different scripts. Preserve a stable source identifier where available and retain its provenance.

## Choose a risk-based sample

Include:

- common names and initials;
- diacritics and multiple scripts;
- stage names and former credited names;
- people with several roles;
- series-level and episode-level credits;
- grouped versions from different sources;
- records recently imported or migrated;
- known good controls.

Audit every suspected identity collision. A wrong person merge can contaminate many search results, while a punctuation difference usually has lower impact.

## Run identity and scope tests

For each sampled claim, ask:

1. Does the stable identifier resolve to the intended person?
2. Does reliable source evidence support the credited name?
3. Is the role represented at the correct level?
4. Is a character name stored separately from the contribution role?
5. Does the order come from a defined source, or was it created locally?
6. Are alternate names attached to the person rather than every work title?
7. Do versions or episodes legitimately differ?

When identity cannot be established, keep the records separate or unresolved. A false merge is harder to detect than two temporarily separate names.

## Classify credit defects

- duplicate person records with verified shared identity;
- two people incorrectly merged because names match;
- inconsistent preferred-name display;
- missing or wrong contribution role;
- character name used as person name;
- series credit incorrectly inherited by every episode;
- episode credit incorrectly promoted to the whole series;
- unsupported billing order;
- lost diacritic or script;
- source conflict or insufficient evidence.

Use [the source-identifier audit](/blog/audit-media-source-identifiers/) before consolidating identities. Add recurring causes to [the metadata quality audit](/blog/media-metadata-quality-audit/).

## Correct one relationship layer

Choose whether the problem belongs to identity mapping, name display, role vocabulary, record scope, or presentation. Apply one supported correction to a small batch, preserve the baseline, and refresh normally.

Then use [person-credit search](/blog/find-media-by-person-credits/) with the preferred name, a verified alternate name, and a role-plus-title combination. Inspect false positives and missing expected works. A visually cleaner credit list is not successful if retrieval worsens.

Norva can organise metadata from compatible authorised sources, but available credit depth, ordering, and identifiers depend on those sources.

## Protect provenance and respectful representation

Retain the form actually credited for a specific work when relevant, while using a verified preferred display form according to policy. Avoid inferring identity, gender, nationality, or relationship from names. Corrections involving a person’s name deserve reliable evidence and careful review.

## Common mistakes and limitations

- Merging people because displayed names match.
- Treating stage and legal names as competing errors.
- Applying a series credit to every episode automatically.
- Storing character names as contribution roles.
- Sorting credits alphabetically and calling it billing order.
- Removing diacritics to improve matching.

Public sources may disagree or omit uncredited contributions. Preserve uncertainty and scope instead of manufacturing a complete list.

## Frequently asked questions

### Should alternate names appear on every card?

Usually not. Keep them as verified identity or search access points and show additional forms where they help disambiguation.

### Can one person have several roles on the same title?

Yes. Store distinct contribution claims rather than collapsing them into an ambiguous combined label.

### What if a series and episode list different creators?

Both can be correct at their respective scopes. Audit inheritance rules so series-level context does not overwrite episode-specific credits.

## Your next step

[Explore Norva's features](https://norva.tv/#features)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva features](https://norva.tv/#features)
