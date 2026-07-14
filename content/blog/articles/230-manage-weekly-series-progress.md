---
content_id: "NVB-230"
title: "How to Keep Weekly Series Progress Understandable"
seo_title: "Keep Weekly Series Progress Understandable"
meta_description: "Keep weekly series progress clear with a ledger for the last confirmed episode, next expected item, source availability, viewer, cadence, and unresolved state."
slug: "manage-weekly-series-progress"
canonical_url: "https://norva.tv/blog/manage-weekly-series-progress/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can weekly series progress remain understandable?"
supporting_questions:
  - "How should released, available, watched, and next states differ?"
  - "What happens when a weekly cadence changes or an episode is delayed?"
audience:
  - "People following series on a weekly schedule"
  - "Norva users tracking progress between episode releases"
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
excerpt: "A weekly release-and-viewing ledger separates episode publication, current source availability, personal completion, and the next expected action."
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
parent_pillar: "/blog/series-library-workflow-guide/"
related_articles:
  - "/blog/verify-next-episode/"
  - "/blog/separate-household-series-progress/"
  - "/blog/audit-series-after-source-update/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "weekly release-and-viewing ledger"
  summary: "A ledger separates authoritative release date, source availability check, viewer completion, next expected episode, cadence confidence, exceptions, and next review."
  methodology: "Readers update one row after viewing and one row after a verified release change, never infer availability from cadence, and reconcile each viewer separately."
  asset_urls: []
---

# How to Keep Weekly Series Progress Understandable

> **In short:** Track four states separately: released by the authoritative schedule, available in the current authorized source, completed by this viewer, and expected next. Update the ledger after each viewing and after verified schedule changes. Never mark an episode missing merely because a usual weekly cadence changed, and never mark it watched simply because the next episode has appeared.

Weekly viewing mixes external schedule state with personal progress. A single “up to date” label cannot explain whether the latest episode is unreleased, unavailable, unwatched, in progress, or completed by another household member.

## Build the release-and-viewing ledger

| Episode | Authoritative release | Available checked | Viewer state | Next expected | Cadence confidence | Exception |
|---|---|---|---|---|---|---|
|  |  |  | Unwatched / in progress / complete |  | High / medium / low |  |

Use a separate ledger or profile scope for each viewer. Do not put two people's completion into one ambiguous checkbox.

## Separate the four states

### Released

The episode has reached its verified public release or transmission point in the relevant territory. Record the source and time zone when timing matters.

### Available now

A compatible source the user is authorized to access currently exposes a playable item. Availability can lag or change independently of release.

### Viewed

This viewer completed or partially watched the verified episode version. Store in-progress position separately from completion.

### Expected next

This is the episode predicted by the verified hierarchy and current schedule. It is not yet a promise of release or availability.

Dublin Core separates available, date, relation, and temporal properties. The personal workflow benefits from the same boundaries.

## Establish a cadence confidence

Record the observed or officially announced cadence with its evidence date. Then label confidence:

- **High:** a current authoritative schedule lists the next episode.
- **Medium:** recent pattern is consistent, but no next event is confirmed.
- **Low:** hiatus, changes, or incomplete metadata make prediction unreliable.

Do not auto-create future episodes from a pattern alone.

## Update after viewing

After each session:

1. verify episode identity and version;
2. mark in progress or complete for the correct viewer;
3. record the next expected episode from hierarchy;
4. check any special or split-season boundary;
5. set the next schedule review.

Use [the next-episode preflight](/blog/verify-next-episode/) before starting the following entry.

## Handle delays and hiatuses

When an expected date passes without a verified episode:

- preserve the last confirmed completion;
- change schedule confidence, not episode identity;
- check authoritative schedule and source freshness;
- mark “release unconfirmed” or “not currently available”;
- avoid skipping to a similarly numbered item.

W3C notification guidance recommends clear status and recovery. “No new episode currently verified; last completed S2E5” is more useful than an empty continue row.

## Keep household progress separate

Use [the household progress workflow](/blog/separate-household-series-progress/) to prevent one viewer's weekly completion from advancing another viewer's next episode. When a shared viewing occurs, update each intended state deliberately.

## Audit after source changes

If titles, numbering, or hierarchy change after refresh, compare the ledger against the new records with [the post-update series audit](/blog/audit-series-after-source-update/). Stable identifiers and dates should bridge the change where available.

After a refresh, reconcile three anchors before accepting the new hierarchy: one previously watched episode, the newest confirmed available episode, and the expected next episode. A mismatch in any anchor keeps the ledger under review.

Norva may sync progress across supported devices and organize compatible authorized sources, but release cadence and current availability come from external source data. Verify schedules rather than inferring a guaranteed weekly release.

## Common mistakes and limitations

- Treating release and source availability as identical.
- Using one “up to date” state for several viewers.
- Generating future episodes from a pattern.
- Marking an episode complete when the next appears.
- Ignoring time zone and hiatus changes.
- Overwriting stable progress during a metadata refresh.

## Frequently asked questions

### Does weekly mean exactly seven days?

Not safely. Use an authoritative current schedule; holidays, hiatuses, and release changes can break the pattern.

### What if the episode is released but unavailable?

Keep release confirmed, availability separate, and personal progress unchanged.

### How should a shared household viewing be recorded?

Update each participating viewer or ledger explicitly rather than changing a global series state.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
