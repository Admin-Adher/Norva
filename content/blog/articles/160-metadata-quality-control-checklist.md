---
content_id: "NVB-160"
title: "A Metadata Quality-Control Checklist for Personal Libraries"
seo_title: "Media Metadata Quality-Control Checklist"
meta_description: "Use a metadata quality-control checklist for identity, provenance, completeness, validity, consistency, relationships, language, display, changes, and exceptions."
slug: "metadata-quality-control-checklist"
canonical_url: "https://norva.tv/blog/metadata-quality-control-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "checklist"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Which quality-control checks should a personal media library use?"
supporting_questions:
  - "Which metadata failures must block a release or cleanup?"
  - "How should samples, exceptions, and changes be documented?"
audience:
  - "People reviewing personal media metadata"
  - "Catalogue maintainers approving imports and correction batches"
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
excerpt: "Metadata quality control tests identity, provenance, fields, relationships, real choices, presentation, change safety, and exception ownership before approval."
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
  - "/blog/sample-large-library-metadata/"
  - "/blog/prevent-metadata-correction-overwrites/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "metadata quality release gate"
  summary: "A pass, fail, and not-applicable gate covers audit scope, identity, provenance, field quality, relationships, real track choices, display, overwrite controls, exceptions, and closure."
  methodology: "A reviewer executes the checklist against reproducible samples and boundary cases, blocks critical failures, records evidence, and signs off only after post-refresh comparison."
  asset_urls: []
---

# A Metadata Quality-Control Checklist for Personal Libraries

> **In short:** Quality control must verify more than filled fields. Define the source and record scope, confirm identity and provenance, test critical field validity and accuracy, inspect series and version relationships, compare language claims with real choices, review presentation on supported views, and protect corrections through refresh. Any wrong-work result, unexplained identifier collision, false accessibility claim, or unowned destructive risk blocks approval.

Use this checklist after an import, migration, metadata correction batch, source change, or periodic audit. Mark each item **Pass**, **Fail**, or **Not applicable**, and attach evidence.

## Gate 1: scope and sample

- [ ] Catalogue snapshot date and mapping version are recorded.
- [ ] Sources, record types, profiles, and supported views in scope are named.
- [ ] Exclusions and unreachable records are documented.
- [ ] Random or systematic samples are reproducible.
- [ ] Known edge cases are tracked separately from inference samples.
- [ ] Reviewer, date, and checklist version are recorded.

Use [the large-library sampling method](/blog/sample-large-library-metadata/) when full inspection is impractical.

## Gate 2: identity and provenance

- [ ] Stable identifiers include namespace, issuer, entity type, and scope.
- [ ] Title, creators, year, runtime, and relationships support the same work or edition.
- [ ] Identifier collisions and replacements have a disposition.
- [ ] Every corrected value retains its source and evidence.
- [ ] Source copies are not miscounted as independent confirmation.
- [ ] Unknown provenance remains visible as a limitation.

Wrong-work evidence or an incompatible identifier collision is a blocking failure.

## Gate 3: field quality

- [ ] Required fields are defined by record type and user task.
- [ ] Present, missing, unknown, not applicable, unavailable, withheld, and conflicting states remain distinct.
- [ ] Values follow declared formats and controlled vocabularies.
- [ ] Title, year, genre, person credit, synopsis, and artwork samples are accurate.
- [ ] Capitalisation, punctuation, script, and diacritics preserve meaning.
- [ ] Review date, historical event date, and source-modified date are not conflated.

Completeness does not excuse a guessed value.

## Gate 4: relationships and variants

- [ ] Series, season, episode, and special parents are correct.
- [ ] Episode labels and sort order follow the documented policy.
- [ ] Version groups contain the same work and expose meaningful differences.
- [ ] Alternate titles attach to the correct work.
- [ ] Person credits retain the correct role and record scope.
- [ ] Orphans, duplicates, and unresolved relationships are owned.

Open records at the boundaries of each relationship, not only the middle of a season or group.

## Gate 5: languages and real choices

- [ ] Language tags are structurally valid and no more specific than evidence supports.
- [ ] Card and detail summaries do not overstate version-level availability.
- [ ] Audio labels match representative selectable tracks.
- [ ] Subtitle language, full or forced purpose, and accessibility role remain distinct.
- [ ] Unknown track language does not inherit the interface language.
- [ ] Profile preferences behave predictably when the preferred track exists and when it does not.

A false language or accessibility claim is a blocking failure because it directly misleads a viewing choice.

## Gate 6: search and presentation

- [ ] Known titles are retrievable by primary and verified alternate forms.
- [ ] Similar names show enough year, creator, type, or version context.
- [ ] Person search returns expected records without obvious identity collisions.
- [ ] Cards and details describe the same work.
- [ ] Key labels remain readable on web, mobile, and TV where supported.
- [ ] Focus and selected state stay visible in keyboard or remote workflows.

Run real tasks rather than reviewing a metadata table alone.

## Gate 7: change safety

- [ ] Original values, mappings, and identifiers are retained for recovery.
- [ ] Field precedence and refresh rules are documented.
- [ ] Reviewed corrections have a manifest and stable record link.
- [ ] Canary records pass a controlled refresh.
- [ ] Before-and-after counts and field diffs reconcile.
- [ ] Rollback or an explicitly accepted non-recovery decision is documented.

Follow [overwrite protection](/blog/prevent-metadata-correction-overwrites/) before a large refresh.

## Gate 8: defects and closure

- [ ] Every defect has severity, cause status, scope, owner, and retest date.
- [ ] Critical and high failures are closed or explicitly block release.
- [ ] Deferred defects have an evidence trigger, not a vague promise.
- [ ] A second reviewer or fresh-session retest confirmed critical tasks.
- [ ] Observation includes the normal source refresh cycle.
- [ ] Audit limitations and residual risk are written plainly.

Use [the full metadata audit](/blog/media-metadata-quality-audit/) when findings reveal systemic causes.

## Record the release decision

| Gate | Result | Evidence reference | Blocking defect | Owner/retest |
|---|---|---|---|---|
|  |  |  |  |  |

Approve only the bounded scope. A passing sample supports confidence within its documented limits; it does not prove every record will remain correct forever.

The NDSA Levels of Digital Preservation emphasise documented practices, fixity, metadata, and information security. The National Archives inventory guidance likewise begins with systematic knowledge of records. This checklist applies those principles to a personal catalogue without claiming formal archival certification.

Norva can organise compatible authorised sources, while metadata depth and correction controls may vary. Contact support when behaviour is unclear.

## Common mistakes and limitations

- Passing a batch because cards look cleaner.
- Hiding critical defects in an average score.
- Mixing targeted edge cases into prevalence rates.
- Testing one device or one version only.
- Refreshing before preserving original values.
- Signing off unresolved identity conflicts.

Sampling can miss rare failures. Pair periodic audits with rule-based anomaly checks and a route for household reports.

## Frequently asked questions

### Must every gate apply to every batch?

No. Mark a gate not applicable with a reason. Identity, provenance, scope, change safety, and closure should rarely be omitted.

### Who should approve quality control?

Prefer someone other than the person who made the change. In a one-person workflow, use a fresh session and written test script.

### Can a batch pass with low-severity defects?

Yes, when they are bounded, documented, owned, and do not undermine the approved user tasks or safety controls.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Norva Support](https://norva.tv/support)
