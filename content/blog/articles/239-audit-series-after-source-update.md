---
content_id: "NVB-239"
title: "How to Audit a Series After Its Source Metadata Changes"
seo_title: "Audit a Series After Source Metadata Changes"
meta_description: "Compare a series before and after a source refresh with a hierarchy-and-state diff that protects episode identity, progress, language choices, and relationships."
slug: "audit-series-after-source-update"
canonical_url: "https://norva.tv/blog/audit-series-after-source-update/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should a series be audited after source metadata changes?"
supporting_questions:
  - "Which hierarchy and playback fields should be compared?"
  - "How can progress be protected while records are reconciled?"
audience:
  - "Viewers troubleshooting changed series metadata"
  - "Norva users reconciling source refreshes"
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
estimated_reading_minutes: 8
excerpt: "A before-and-after diff separates harmless display changes from identity changes that can misattach progress or variants."
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
  - "/blog/fix-wrong-episode-resume-context/"
  - "/blog/find-gaps-in-episode-sequence/"
  - "/blog/check-language-across-episodes/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.eidr.org/how-we-work"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "series hierarchy-and-state diff ledger"
  summary: "A ledger compares stable identity, hierarchy, display metadata, variants, tracks, availability, and user state before and after refresh."
  methodology: "Readers freeze playback, capture the new snapshot, match records by strongest identifiers, classify changes, reconcile one episode at a time, and verify recovery paths."
  asset_urls: []
---

# How to Audit a Series After Its Source Metadata Changes

> **In short:** Stop playback, preserve the last known-good state, and compare old and new records by stable identifiers before using titles or list positions. Classify each change as display-only, hierarchy, identity, variant, track, availability, or user-state impact. Reconcile one episode at a time and never bulk-move progress across uncertain matches.

A source refresh can improve titles, images, numbering, and track labels. It can also split one record into variants, merge duplicates, move specials, or expose a stale resume point on the wrong episode. An audit distinguishes harmless presentation changes from changes that affect identity and playback state.

## Create the hierarchy-and-state diff

| Field | Before | After | Change class | Confidence | Action |
|---|---|---|---|---|---|
| Series identifier |  |  | Identity |  |  |
| Season identifier |  |  | Hierarchy |  |  |
| Episode identifier |  |  | Identity |  |  |
| Number and title |  |  | Display/hierarchy |  |  |
| Version or variant |  |  | Variant |  |  |
| Audio/subtitles |  |  | Track |  |  |
| Availability |  |  | Source state |  |  |
| Resume/completion |  |  | User state |  |  |

Capture when each snapshot was taken and which authorized source supplied it.

## Freeze additional state first

Do not continue watching while investigating. Record:

- exact series, season, and episode last played;
- resume position and completion state;
- viewer or account context;
- active device;
- selected version, audio, and subtitles;
- current favorites and temporary reminders.

This is your recovery point. If screenshots contain personal information, store them privately and remove them after reconciliation.

## Match by the strongest identity available

Prefer stable identifiers and explicit hierarchy over title text or row position. EIDR’s model separates series, season, episode, edit, and manifestation. That hierarchy illustrates why one visible title is insufficient to prove that two records are the same playable object.

Use this evidence order:

1. matching stable episode and parent identifiers;
2. matching season, episode number, original title, and release data;
3. matching duration and version attributes;
4. title or artwork similarity as supporting evidence only.

Mark unresolved rows instead of forcing a match.

## Classify the change

- **Display-only:** spelling, artwork, description, or localized title changed while identity stayed stable.
- **Hierarchy:** episode moved between season, special, or numbering positions.
- **Identity:** identifiers were replaced, merged, or split.
- **Variant:** a new edit or language version appeared or grouping changed.
- **Track:** audio or subtitle labels or availability changed.
- **Availability:** the source no longer exposes or now exposes the item.
- **User-state impact:** resume, completion, favorite, or history points somewhere different.

DCMI metadata terms separate identifiers, titles, relations, dates, formats, languages, and availability concepts. Keeping those fields separate makes the diff explainable.

## Reconcile in a safe order

1. Confirm the series-level identity.
2. Confirm season and special boundaries.
3. Run [the sequence gap check](/blog/find-gaps-in-episode-sequence/).
4. Match the last completed and in-progress episodes.
5. Compare variants and tracks.
6. Correct one affected state.
7. leave and reopen the page to verify persistence;
8. repeat only after the result is confirmed.

If a resume point moved, use [the wrong-episode resume diagnostic](/blog/fix-wrong-episode-resume-context/) rather than dragging a timestamp to the nearest title.

## Recheck season-wide language coverage

A source update can change which version is grouped first or how tracks are labeled. Run [the season language matrix](/blog/check-language-across-episodes/) for the episodes you intend to watch. A retained preference does not prove that the newly selected variant contains the same track.

Norva can organize variants and retain account state across supported devices, but source metadata and track availability remain external inputs. Check current support material before applying any bulk correction.

## Close the audit

Record the number of matched, changed, unresolved, and unavailable episodes. Then test:

- the next episode from the last completion;
- the resume point on another supported device if relevant;
- favorite retrieval;
- language and subtitle selection;
- recommendations or related works only after core identity is stable.

Keep the before snapshot until every unresolved row has an owner or an accepted limitation.

## Common mistakes and limitations

- Matching episodes by artwork alone.
- Treating renumbering as a display-only change.
- Moving all progress in one operation.
- Ignoring variants and language tracks.
- Deleting the recovery snapshot too early.
- Assuming source availability proves identity continuity.

## Frequently asked questions

### Should every title change trigger a full audit?

Not necessarily. Confirm stable identity first; a display-only correction may need only a quick verification.

### What if no stable identifiers are visible?

Use several independent fields, lower confidence, and avoid moving user state until the match is defensible.

### Can an unavailable episode be marked missing?

Only describe current source availability. It may still exist in the series hierarchy or another authorized record.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
