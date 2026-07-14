---
content_id: "NVB-140"
title: "A Quality Checklist for Finishing a Catalog Cleanup"
seo_title: "Media Catalog Cleanup Quality Checklist"
meta_description: "Finish catalog cleanup with a quality gate covering scope, counts, retrieval, relationships, metadata, personal context, devices, exceptions, rollback, and approval."
slug: "catalog-cleanup-quality-checklist"
canonical_url: "https://norva.tv/blog/catalog-cleanup-quality-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "checklist"
topic_cluster: "Catalog Cleanup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Which quality checks should finish a media catalogue cleanup?"
supporting_questions:
  - "How should cleanup results be reconciled?"
  - "Which failures must block closure?"
audience:
  - "People completing catalogue cleanup"
  - "Reviewers approving a cleanup batch"
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
excerpt: "A cleanup is finished only when scope and counts reconcile, essential tasks pass, relationships and personal context remain intact, and exceptions and recovery are owned."
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
  - "/blog/make-catalog-cleanup-reversible/"
  - "/blog/know-when-to-stop-cleaning/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.ndsa.org/publications/levels-of-digital-preservation/"
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "catalogue cleanup release gate"
  summary: "A pass, fail, and not-applicable release gate tests scope, reconciliation, retrieval, relationships, metadata, state, supported views, exceptions, recovery, and documentation."
  methodology: "A reviewer executes named tests against representative and boundary samples, blocks closure on critical failures, and signs off only after a quiet observation window."
  asset_urls: []
---

# A Quality Checklist for Finishing a Catalog Cleanup

> **In short:** Finish cleanup with an independent quality gate, not the absence of visible errors. Reconcile every record in scope, execute named search and browse tasks, test relationships and personal context, refresh supported views, inspect exceptions, and retain rollback. Any unexplained count, wrong-item result, lost state, or destructive uncertainty blocks closure.

The person who made a change knows what they intended to see. A separate review—or at least a fresh session using written tests—reduces confirmation bias.

## Prepare the release gate

Record the change or batch ID, baseline, final mapping version, reviewer, test time, and supported views in scope. Mark every check **Pass**, **Fail**, or **Not applicable**, with evidence. “Looks good” is not a test result.

Keep pre-existing problems separate. They may be accepted exceptions, but they must not disappear from the record.

## Gate 1: scope and reconciliation

- [ ] Included and excluded records match the approved boundary.
- [ ] Expected, changed, unchanged, exception, and unresolved counts reconcile.
- [ ] No active import, migration, or refresh changed the same scope during the batch.
- [ ] Mapping and source versions are recorded.
- [ ] Every exception has a reason, owner, and review date.

If counts do not reconcile, stop. A missing record is not a rounding error.

## Gate 2: retrieval and navigation

- [ ] A known item can be found through search.
- [ ] A category browse reaches the expected sample.
- [ ] Former names or routes behave as documented.
- [ ] Empty or hidden structures no longer obstruct normal browsing.
- [ ] Boundary items at the beginning and end of the batch appear correctly.

Use real household tasks defined in [the pre-cleanup audit](/blog/audit-library-before-cleanup/), not only administrative views.

## Gate 3: identity and relationships

- [ ] Titles, years, and distinguishing labels identify the intended work.
- [ ] Series, seasons, and episodes retain correct parent-child order.
- [ ] Version groups contain only matching works and useful variants.
- [ ] Orphan candidates are resolved or explicitly owned.
- [ ] Category membership and intake mappings agree.

Open representative records rather than judging cards from artwork alone.

## Gate 4: metadata and choice

- [ ] Category names follow the approved convention.
- [ ] Language and subtitle labels are understandable and match selectable tracks in the sample.
- [ ] Runtime, synopsis, poster, and genre anomalies are resolved or documented.
- [ ] Source or version labels provide enough context for a choice.
- [ ] Unknown values remain unknown rather than being guessed.

Metadata completeness is not required when information is unavailable; misleading certainty is the greater defect.

## Gate 5: personal context

- [ ] Partly watched samples retain expected progress.
- [ ] Favourite and history samples resolve to the intended records.
- [ ] Profile-specific preferences remain scoped correctly.
- [ ] Preferred version and language choices behave as expected.
- [ ] Any accepted loss was approved before the change.

This gate is especially important after regrouping, removal, re-import, or migration.

## Gate 6: supported views and timing

- [ ] The normal refresh completed without repeated intervention.
- [ ] Web, mobile, or TV views included in the approved scope show consistent catalogue relationships.
- [ ] Focus, labels, and key actions remain usable in the relevant view.
- [ ] A second session or observer reproduced essential tasks.
- [ ] No new high-impact exception appeared during the observation window.

Norva supports web, mobile, and TV experiences, but connected-source behaviour and available metadata may differ. Test only supported, relevant combinations and record them.

## Gate 7: recovery and closure

- [ ] Baseline evidence and rollback instructions are readable.
- [ ] Recovery was tested or the documented low-risk exception was approved.
- [ ] Temporary files and parallel mappings have a retention or retirement decision.
- [ ] The final change record includes results and lessons.
- [ ] The owner and reviewer signed the closure decision.

Follow [the reversible cleanup guide](/blog/make-catalog-cleanup-reversible/) when any recovery element is missing. Compare the outcome with [the clean-enough criteria](/blog/know-when-to-stop-cleaning/) before opening more cosmetic work.

## Use a defect disposition table

| Defect | Severity | Scope | Cause known? | Action | Owner | Retest date |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

Critical defects—wrong item, unintended deletion, broken essential retrieval, or unexpected loss of personal context—block closure. Lower-impact defects may be deferred only with a documented reason and owner.

The NDSA Levels of Digital Preservation emphasise checks, fixity, metadata, and documented practices across increasing levels of maturity. A catalogue quality gate similarly makes confidence depend on evidence, not the number of edits performed.

## Common mistakes and limitations

- Letting the implementer approve from memory.
- Testing only the most obvious item.
- Ignoring batch boundaries and exceptions.
- Treating one screen as proof of all supported views.
- Deleting rollback material immediately after tests.
- Turning every minor defect into an endless project.

Sampling reduces effort but cannot prove every record is correct. Use broader testing when changes are destructive, heterogeneous, or poorly understood.

## Frequently asked questions

### Who should run the final checklist?

Prefer someone who did not execute the batch. For a one-person household, use a written script in a fresh session and avoid reviewing immediately after implementation.

### Can a cleanup close with known defects?

Yes, when defects are non-critical, bounded, documented, owned, and accepted. Critical safety or essential-task failures must remain open.

### How long should the observation window be?

Long enough to include the normal source refresh and representative use. Document the chosen period; there is no universal duration.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [NDSA: Levels of Digital Preservation](https://www.ndsa.org/publications/levels-of-digital-preservation/)
- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Norva Support](https://norva.tv/support)
