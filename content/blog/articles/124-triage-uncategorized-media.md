---
content_id: "NVB-124"
title: "A Triage Method for Uncategorized Media Items"
seo_title: "Triage Uncategorized Media Items"
meta_description: "Triage uncategorized media by confirming scope, source, identity, metadata, relationships, and destination while routing uncertain cases to review."
slug: "triage-uncategorized-media"
canonical_url: "https://norva.tv/blog/triage-uncategorized-media/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I triage uncategorised media items?"
supporting_questions:
  - "Which evidence is needed before assigning a category?"
  - "When should an item remain in review?"
audience:
  - "People cleaning an uncategorised media queue"
  - "Households maintaining category rules"
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
estimated_reading_minutes: 6
excerpt: "A reliable triage process confirms scope, source, item identity, relationships, required metadata, and destination before assigning a category."
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
parent_pillar: "/blog/catalog-cleanup-master-plan/"
related_articles:
  - "/blog/audit-library-before-cleanup/"
  - "/blog/plan-metadata-rules-before-import/"
  - "/blog/remove-empty-library-categories/"
cta:
  label: "Explore Norva's Catalog Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.archives.gov/records-mgmt/scheduling/knowing"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "six-gate uncategorised item triage card"
  summary: "A gate-based worksheet separates ready items from metadata, duplicate, source, rights, and scope exceptions."
  methodology: "Readers process a small batch, require evidence at each gate, track decision time and exception type, and revise category rules only when the same ambiguity repeats."
  asset_urls: []
---

# A Triage Method for Uncategorized Media Items

> **In short:** Process uncategorised items through six gates: collection scope, authorised source, item identity, work/version relationship, minimum metadata, and destination rule. Assign a category only when the evidence supports it. Send missing, conflicting, duplicate, or rights-related cases to named review queues rather than a permanent miscellaneous bucket.

An uncategorised item is a symptom. The cause may be a new media type, missing metadata, unclear source, duplicate relationship, or a category rule that no longer fits. Triage should reveal that cause before editing.

## Gate 1: confirm collection scope

Ask whether the item belongs in the current phase by media type, source, household use, language, time boundary, and active/archive rule.

If out of scope, leave it unchanged or route it to a documented future review. Do not create a new category merely to absorb one exception.

## Gate 2: confirm source and authorisation

Record the compatible source and verify that the user owns it or is legally authorised to use it. If source identity or authorisation is uncertain, stop classification and assign an owner to resolve it.

Never place credentials, tokens, or private source addresses in the triage sheet.

## Gate 3: establish item identity

Record the title, media type, date or year where available, and a stable source identifier. Distinguish:

- film versus episode;
- work versus exact version;
- collection versus member;
- media item versus metadata-only card;
- available versus unavailable source version.

Do not infer identity from artwork alone.

## Gate 4: check relationships and duplicates

Search the catalogue for matching identifiers, titles, dates, sources, versions, and languages. Use three states:

- confirmed relationship;
- possible relationship needing review;
- distinct item.

Matching titles alone do not prove a duplicate. Preserve both candidates until version and source evidence is sufficient.

## Gate 5: verify minimum metadata

Apply [the pre-import metadata rules](/blog/plan-metadata-rules-before-import/). Required values should support a findability or maintenance task. Allow explicit unknown, absent, not applicable, and conflict states.

If a value is missing, do not guess. Route it to a metadata queue with the evidence needed and person responsible.

## Gate 6: apply a destination rule

A category should have a stable definition that another maintainer can apply. Check:

- inclusion rule;
- exclusion rule;
- relationship to other categories;
- active or archive status;
- source dependency;
- household findability task served.

When no existing rule fits, record the item in “category design review.” Do not create a live category until several real items or a clear near-term need justify it.

## Use separate exception queues

Keep distinct queues for:

- metadata missing;
- duplicate or version review;
- source or access review;
- rights or authorisation review;
- out of scope;
- category design;
- technical error.

One “miscellaneous” queue hides the action needed. Give every queue an owner, evidence requirement, and review cadence.

## Original evidence: six-gate triage card

| Gate | Evidence | Result | Next action |
| --- | --- | --- | --- |
| Scope |  | Pass / Review |  |
| Source/authorisation |  | Pass / Review |  |
| Identity |  | Pass / Review |  |
| Relationships |  | Pass / Review |  |
| Minimum metadata |  | Pass / Review |  |
| Destination rule |  | Pass / Review |  |

Process ten representative items. Record how many pass directly, which queue receives each exception, and which rule causes repeated ambiguity. Feed the baseline from [the pre-cleanup audit](/blog/audit-library-before-cleanup/) into this card.

## Improve the rule, not just the queue

After one batch, review recurring causes. If several items fail the same gate:

- clarify scope;
- add a supported metadata mapping;
- define a version relationship;
- split an overloaded category;
- change intake rules;
- document a source limitation.

Update [the complete cleanup plan](/blog/catalog-cleanup-master-plan/) before scaling. For categories that become empty after valid reclassification, use [the empty category cleanup guide](/blog/remove-empty-library-categories/).

## Common mistakes and limitations

- Creating a category for every exception.
- Guessing missing metadata.
- Treating matching titles as duplicates.
- Mixing rights review with ordinary categorisation.
- Keeping one permanent miscellaneous bucket.
- Processing large batches before validating the gates.
- Hiding unavailable items instead of preserving status.

Source metadata can be incomplete or inconsistent. Norva can organise and group variants from a compatible authorised source, but it cannot guarantee upstream data completeness.

## Frequently asked questions

### How many uncategorised items should I process at once?

Use a batch small enough to inspect and review, but varied enough to reveal common exception types. Ten to twenty may be a practical pilot, not a universal rule.

### Is “Other” a valid category?

Only when it has a clear stable meaning and retrieval purpose. It should not become a substitute for unresolved triage.

### What if no category fits one valid item?

Place it in category design review. Decide whether the item is out of scope, archival, or evidence that a new category serves a repeatable need.

## Your next step

[Explore Norva's catalog features](https://norva.tv/#features)

## Sources

- [National Archives: Knowing your records](https://www.archives.gov/records-mgmt/scheduling/knowing)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva features](https://norva.tv/#features)
