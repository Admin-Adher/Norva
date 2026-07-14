---
content_id: "NVB-153"
title: "Missing or Unknown? Label Incomplete Metadata Clearly"
seo_title: "Label Missing and Unknown Media Metadata Clearly"
meta_description: "Distinguish missing, unknown, not applicable, withheld, unresolved, and unavailable media metadata so interfaces, audits, and correction queues remain honest."
slug: "missing-vs-unknown-metadata"
canonical_url: "https://norva.tv/blog/missing-vs-unknown-metadata/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "concept-explainer"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between missing and unknown media metadata?"
supporting_questions:
  - "Which incomplete-data states should be distinguished?"
  - "How should those states appear in interfaces and audits?"
audience:
  - "People reviewing incomplete media metadata"
  - "Catalogue maintainers designing correction queues"
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
excerpt: "A blank field can mean no value arrived, nobody knows the value, the field does not apply, access is restricted, or a conflict remains unresolved."
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
  - "/blog/triage-missing-synopses/"
  - "/blog/metadata-quality-control-checklist/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.archives.gov/records-mgmt/scheduling/knowing"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "incomplete-metadata state model"
  summary: "A state model separates absent, unknown, not applicable, withheld, unavailable, conflicting, and not-yet-reviewed values with transitions and ownership."
  methodology: "Readers classify blanks by evidence, define display and audit behaviour for each state, route actionable gaps, and prevent guessed values from masquerading as completeness."
  asset_urls: []
---

# Missing or Unknown? Label Incomplete Metadata Clearly

> **In short:** “Missing” means an expected value is absent from the record; “unknown” means the value has been investigated but cannot currently be established. Also distinguish not applicable, withheld, inaccessible from the connected source, conflicting, and not yet reviewed. Store the state separately from display wording, and never replace uncertainty with a plausible guess merely to improve completeness.

A blank field hides cause. Reviewers cannot tell whether to fetch, investigate, ignore, protect, or escalate it, and viewers may interpret an empty space as an interface failure.

## Use an incomplete-metadata state model

Define these states:

- **Present:** a value exists with adequate provenance for its use.
- **Missing:** the field is expected, but no value arrived or was retained.
- **Unknown:** investigation found no reliable value.
- **Not applicable:** the field has no meaning for this record type.
- **Unavailable:** a value may exist, but the authorised connected source does not expose it.
- **Withheld:** the value is deliberately not displayed or processed under a policy.
- **Conflicting:** credible values disagree and no rule resolves them yet.
- **Not reviewed:** no one has assessed the blank or candidate value.

These states are operational, not decorative. “Unknown” should not automatically return to a work queue every month unless new evidence appears.

## Build the state-transition card

For each incomplete field, record:

| Record/field | Current state | Evidence | Expected? | Next action | Owner | Review trigger | Display rule |
|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |

Allow only documented transitions. For example:

- not reviewed → missing after confirming the field is expected;
- missing → present after a verified source value arrives;
- conflicting → present after applying an approved evidence rule;
- missing → unknown after a bounded investigation;
- present → withheld when a privacy or policy decision changes display.

Keep the previous state, date, and reason in the change record.

## Decide whether a field is expected

Expectation depends on record type and task. Episode number may be expected for a regular episode but not for an unnumbered extra. Subtitle language is expected only for a track that exists. A synopsis may be useful but not available from every source.

Use [the metadata quality audit](/blog/media-metadata-quality-audit/) to link fields to user tasks. Completeness should use an eligible-field denominator, not every possible field across every record.

Dublin Core provides a set of descriptive terms but does not require every property for every resource. That supports a central principle: absence must be interpreted in context.

## Separate storage from display

Store the precise state where supported, then choose concise display language:

- hide a non-essential not-applicable field;
- display “Unknown year” when the missing value affects identity;
- show “Track language not provided” when a choice must remain honest;
- indicate “Under review” only when an active owner and next action exist;
- avoid exposing internal error codes to viewers.

Do not make unknown and zero equivalent. A runtime of zero, season zero, or empty string may have different meanings and requires validation.

## Route actionable gaps

Use four queues:

1. **Fetch or refresh:** source normally supplies the field and a supported refresh is appropriate.
2. **Investigate:** identity, provenance, or conflicting evidence needs human review.
3. **Correct presentation:** data exists but display or truncation hides it.
4. **Accept and monitor:** unknown, unavailable, withheld, or not applicable is documented.

For descriptive text, follow [the missing-synopsis triage](/blog/triage-missing-synopses/). Do not create prose from unverified assumptions.

## Validate the interface and metrics

Sample each state on web, mobile, and TV where supported. Check that it remains distinguishable, readable, and non-blocking. Run [the metadata quality-control checklist](/blog/metadata-quality-control-checklist/) after changing the model.

Report completeness alongside state distribution. “92% present, 3% missing, 2% unknown, 2% not applicable, 1% conflicting” is more actionable than “8% blank.” State percentages should use a declared scope and date.

Norva can organise metadata from compatible authorised sources, but field availability depends on those sources.

## Common mistakes and limitations

- Treating every blank as missing.
- Filling unknown values from the most common pattern.
- Counting not-applicable fields as defects.
- Displaying “under review” with no owner.
- Collapsing source-unavailable and deliberately withheld states.
- Using zero as a generic null value.

Some products cannot store every state natively. Keep the distinction in the audit ledger and use the least misleading supported display.

## Frequently asked questions

### Is “N/A” a good viewer-facing label?

It is compact but ambiguous. Hide genuinely irrelevant fields or use plain wording when the distinction matters to a choice.

### When should unknown be reviewed again?

Set an evidence trigger, such as a source update, migration, or newly authoritative record, rather than reopening it on every routine audit.

### Does a missing value always reduce metadata quality?

Only when the field is expected and its absence affects a defined task or policy. Context and consequence determine severity.

## Your next step

[See how Norva works](https://norva.tv/#how-it-works)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [National Archives: Knowing your records](https://www.archives.gov/records-mgmt/scheduling/knowing)
- [Norva: How it works](https://norva.tv/#how-it-works)
