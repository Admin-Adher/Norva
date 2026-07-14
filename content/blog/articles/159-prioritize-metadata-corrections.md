---
content_id: "NVB-159"
title: "Which Metadata Problems Should You Fix First?"
seo_title: "Which Media Metadata Problems Should You Fix First?"
meta_description: "Prioritize metadata fixes by user consequence, affected reach, evidence confidence, dependency, reversibility, effort, and recurrence instead of visible annoyance."
slug: "prioritize-metadata-corrections"
canonical_url: "https://norva.tv/blog/prioritize-metadata-corrections/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "decision-guide"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Which media metadata problems should be fixed first?"
supporting_questions:
  - "How should consequence and evidence be balanced?"
  - "Which metadata defects require investigation before correction?"
audience:
  - "People managing a metadata correction backlog"
  - "Catalogue reviewers choosing safe repair batches"
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
excerpt: "Identity, wrong-item, accessibility, relationship, and destructive-risk defects usually outrank harmless style inconsistencies, but evidence and reversibility determine the next action."
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
  - "/blog/build-metadata-confidence-score/"
  - "/blog/sample-large-library-metadata/"
  - "/blog/metadata-quality-control-checklist/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "consideration"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "metadata correction priority compass"
  summary: "A compass evaluates consequence, reach, evidence, dependency, recurrence, reversibility, and effort, with vetoes for destructive or identity-uncertain changes."
  methodology: "Readers classify defects into stabilise, correct, investigate, monitor, or style queues, select a coherent batch, and define task-based completion tests."
  asset_urls: []
---

# Which Metadata Problems Should You Fix First?

> **In short:** Fix defects that can lead to the wrong item, lost relationships, misleading language or accessibility choices, or unsafe cleanup before cosmetic inconsistencies. Then consider how many records and tasks are affected, whether the cause is recurring, how strong the evidence is, and whether the change is reversible. High consequence plus weak evidence means investigate first—not guess faster.

A wrong poster may be a minor artwork issue or a sign of a wrong-work match. Priority depends on consequence and cause, not the field name alone.

## Describe the defect as a failed task

Write one observable statement:

- “Two different films share one source identifier and search opens the wrong details.”
- “The card claims French audio, but the selected version offers no French track.”
- “Season two episodes sort under season one after refresh.”
- “Seven titles use inconsistent capitalisation with no search impact.”

The first three affect identity, choice, or navigation. The fourth may still be worth fixing, but normally belongs later.

## Use the metadata correction priority compass

Rate each dimension low, medium, or high and write the reason:

| Dimension | Question |
|---|---|
| Consequence | What can a viewer misunderstand, miss, or lose? |
| Reach | How many records, sources, profiles, or tasks are affected? |
| Evidence | Do identifiers, provenance, samples, and direct checks agree? |
| Dependency | Does this defect block grouping, migration, or other corrections? |
| Recurrence | Will the source or rule recreate it? |
| Reversibility | Can the change and relationships be restored? |
| Effort | How much review and exception handling are required? |

The compass is deliberately not one opaque number. A destructive action with high consequence and low reversibility should remain visible instead of being averaged into a moderate score.

## Apply priority vetoes

Do not schedule a correction batch when:

- work or person identity is uncertain;
- source namespace or field meaning is unknown;
- a destructive action lacks recovery;
- personal context has not been mapped;
- the same source scope is actively importing or migrating;
- success cannot be tested;
- rights or authorisation for replacement metadata are unclear.

A veto creates an investigation task with an owner and evidence requirement.

## Sort into five queues

1. **Stabilise:** stop an active import, mapping, or overwrite problem that compounds defects.
2. **Correct:** high-consequence, well-evidenced, reversible issues.
3. **Investigate:** serious but ambiguous identity, provenance, or source conflicts.
4. **Monitor:** low-consequence uncertainty with an explicit trigger.
5. **Style:** punctuation, capitalisation, and presentation consistency with no material task failure.

Use [the confidence-score framework](/blog/build-metadata-confidence-score/) to expose evidence quality, not to make the final priority decision.

## Compare field consequences

A practical default order is:

- wrong work, person, episode, or source identity;
- false language, subtitle, or accessibility claim;
- broken series, season, episode, or version relationship;
- missing personal-context continuity;
- search-critical title, year, and alternate-name defects;
- misleading synopsis or artwork;
- genre and browse consistency;
- low-impact style variation.

Override the default when local evidence shows a different consequence. A poster defect attached to a wrong identifier belongs at the top, not in artwork polish.

## Select a coherent repair batch

Use [large-library sampling](/blog/sample-large-library-metadata/) to confirm scope and cause. Batch one source, rule, field transformation, or relationship defect. Define expected count, exception types, rollback, and real user-task tests.

After correction, run [the metadata quality-control checklist](/blog/metadata-quality-control-checklist/). Re-rank the backlog because one root-cause fix may close many symptoms.

The National Archives inventory guidance emphasises systematic knowledge of scope and records; prioritisation without inventory can overreact to a visible example. The NDSA Levels of Digital Preservation similarly favour documented, progressive controls.

Norva can organise compatible authorised sources, while metadata behaviour and correction controls vary by source.

## Common mistakes and limitations

- Prioritising the field with the most blanks.
- Treating visible artwork as automatically cosmetic.
- Correcting high-risk ambiguity without evidence.
- Counting source copies as independent confirmation.
- Opening unrelated repair batches together.
- Measuring success by fields changed rather than tasks restored.

The compass supports local judgement. It does not create universal severity where household tasks and source risk differ.

## Frequently asked questions

### Should quick wins come before identity defects?

Only when the identity issue is safely stabilised and needs investigation. Quick wins must not consume the attention needed to prevent compounding harm.

### Is missing metadata always low priority?

No. A missing identifier, episode number, or language label can block identity or choice; a missing decorative field may have little impact.

### How often should priorities be recalculated?

After each repair batch, source change, migration, or discovery of a systemic cause. Evidence and dependencies change as work closes.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [Norva Support](https://norva.tv/support)
