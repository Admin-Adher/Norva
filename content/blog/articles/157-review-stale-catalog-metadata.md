---
content_id: "NVB-157"
title: "How to Identify Metadata That May Be Out of Date"
seo_title: "Identify Media Metadata That May Be Out of Date"
meta_description: "Identify stale media metadata with field-specific triggers, source and mapping changes, contradiction signals, review dates, provenance, and evidence-based revalidation."
slug: "review-stale-catalog-metadata"
canonical_url: "https://norva.tv/blog/review-stale-catalog-metadata/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can media metadata that may be out of date be identified?"
supporting_questions:
  - "Which events should trigger revalidation?"
  - "How can old-but-stable facts be separated from stale operational metadata?"
audience:
  - "People maintaining changing media catalogues"
  - "Catalogue reviewers planning metadata refreshes"
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
excerpt: "Metadata becomes stale when its evidence, source relationship, or operational meaning no longer supports the current record—not simply because it is old."
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
  - "/blog/prevent-metadata-correction-overwrites/"
  - "/blog/audit-media-source-identifiers/"
  - "/blog/monthly-catalog-cleanup-routine/"
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
  type: "field freshness trigger map"
  summary: "A trigger map connects each field to its evidence date, source and mapping version, volatility class, contradiction signals, review event, and owner."
  methodology: "Readers classify field volatility, identify event-driven and age-based triggers, sample candidates, verify against current evidence, and record revalidation without bulk overwriting."
  asset_urls: []
---

# How to Identify Metadata That May Be Out of Date

> **In short:** Age alone does not make metadata stale. A historical release year may remain stable for decades, while source availability or version grouping can change overnight. Mark fields for review when their source, identifier, mapping, media asset, or operational context changes; when current evidence contradicts them; or when a field-specific review interval expires. Revalidate before replacing anything.

“Last updated” is useful only when it records what changed and why. Re-saving a record can make old evidence appear fresh without improving accuracy.

## Classify fields by volatility

Use three broad classes:

- **Stable descriptive facts:** original title, creators, original release event, and work identity. They can be wrong, but usually change because evidence improves rather than the work changing.
- **Edition or source-relative facts:** runtime, tracks, artwork, version labels, source identifiers, and availability. They can change when media or source records change.
- **Operational and personal state:** progress, favourites, hidden state, mappings, and profile preferences. These can change frequently and require a different audit boundary.

Do not assign one freshness interval to all three.

## Build the field freshness trigger map

| Field | Volatility | Evidence date | Source/mapping version | Trigger | Contradiction signal | Owner |
|---|---|---|---|---|---|---|
|  | stable/relative/operational |  |  |  |  |  |

Useful triggers include:

- source reconnection, migration, or identifier replacement;
- media file or source asset replacement;
- version group split or merge;
- new language or subtitle track detected;
- artwork or synopsis no longer matching identity;
- credible source conflict;
- repeated viewer correction;
- field-specific review date reached;
- a related correction changes the record context.

The trigger should route a claim to review, not overwrite it automatically.

## Look for contradiction patterns

Create safe checks for:

- identifier points to a different title or edition;
- runtime changed materially while version label did not;
- language badge disagrees with selectable tracks;
- release year conflicts with the currently matched work;
- poster and synopsis describe another record;
- series relation points to an inactive or replaced parent;
- a reviewed value reverted after refresh;
- source last-seen date predates a major migration.

Use [the source-identifier audit](/blog/audit-media-source-identifiers/) when continuity changed and [overwrite protection](/blog/prevent-metadata-correction-overwrites/) when a reviewed value unexpectedly reverted.

## Separate stale from merely old

For each candidate, answer:

1. What exact claim is being reviewed?
2. Which evidence originally supported it?
3. What event or contradiction makes that evidence insufficient now?
4. Does current authoritative evidence support the same value, a replacement, or uncertainty?
5. Which related fields and views would a change affect?

If no event or contradiction exists, an old review date alone may justify sampling but not mass correction.

Dublin Core includes date properties such as created, modified, and issued, illustrating that dates need semantics. Keep “source modified,” “record reviewed,” and “value effective” as different timestamps.

## Create a revalidation queue

Prioritise by consequence and trigger strength:

- **Immediate:** identity, wrong-item, accessibility, or destructive-action risk.
- **High:** search, series order, version selection, or source continuity affected.
- **Routine:** source-relative field exceeded its review rule without visible contradiction.
- **Monitor:** stable fact is old but remains supported.

Review one coherent source or field batch. Preserve current values, evidence, and personal context before applying corrections.

## Record the revalidation outcome

Use statuses:

- confirmed current;
- corrected with new evidence;
- still conflicting;
- source unavailable;
- protected pending migration;
- not applicable;
- deferred with owner and trigger.

Update the evidence date and reviewer, not the original historical event date. Include the outcome in [the monthly catalogue routine](/blog/monthly-catalog-cleanup-routine/) so recurring source drift becomes visible.

The Library of Congress inventory and custody guidance emphasises ongoing knowledge of collection content and stewardship. A trigger-based freshness record similarly preserves knowledge as sources change.

Norva can organise compatible authorised sources, while metadata updates and source last-seen information may vary.

## Common mistakes and limitations

- Treating every old timestamp as an error.
- Refreshing values before capturing provenance.
- Using one date for source, review, and historical event.
- Revalidating presentation while ignoring identity.
- Letting a save action reset evidence age.
- Reviewing repeatedly with no new trigger.

A source update timestamp does not prove every field changed or became more accurate. Review the field claim and its provenance.

## Frequently asked questions

### How often should stable title metadata be reviewed?

Use event and contradiction triggers first. Periodic sampling can catch hidden defects, but there is no universal expiry date for a verified historical fact.

### Is newer metadata always better?

No. A newer source record can be incomplete or mismatched. Compare identity, provenance, and field semantics.

### Should a stale candidate disappear from the interface?

Usually not automatically. Keep the last supported value with its provenance or show uncertainty according to policy while review is pending.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva Support](https://norva.tv/support)
