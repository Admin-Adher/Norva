---
content_id: "NVB-208"
title: "How to Build a Movie Shortlist Around Available Time"
seo_title: "Build a Movie Shortlist Around Available Time"
meta_description: "Build a runtime-based movie shortlist by calculating usable playback time, verifying version runtimes, adding transition buffers, and ranking only valid options."
slug: "build-runtime-based-movie-shortlist"
canonical_url: "https://norva.tv/blog/build-runtime-based-movie-shortlist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Movie Library Workflows"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can a movie shortlist be built around the time actually available?"
supporting_questions:
  - "How should setup, breaks, and decision time affect the budget?"
  - "Why must runtime be verified for the selected version?"
audience:
  - "People choosing a movie within a fixed time window"
  - "Users planning realistic movie sessions"
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
estimated_reading_minutes: 7
excerpt: "A session budget subtracts setup, decision, break, and finish-margin time before any movie qualifies by runtime."
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
parent_pillar: "/blog/movie-library-workflow-guide/"
related_articles:
  - "/blog/plan-personal-movie-night/"
  - "/blog/create-weekend-movie-queue/"
  - "/blog/choose-between-alternate-cuts/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.eidr.org/faq"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "usable playback budget worksheet"
  summary: "A worksheet subtracts setup, decision, breaks, interruption risk, and finish margin from the session window, then validates version-specific runtimes against the remainder."
  methodology: "Readers calculate a conservative usable budget, filter broadly, verify each finalist's exact version runtime, and reject options that fit only by ignoring transition time."
  asset_urls: []
---

# How to Build a Movie Shortlist Around Available Time

> **In short:** Start with the time by which viewing must end. Subtract setup, decision time, planned breaks, and a finish margin; the remainder is the usable playback budget. Filter for movies below that budget, then verify the exact version runtime because alternate cuts can differ. Rank only movies that fit without optimistic assumptions, and keep one shorter fallback.

“We have two hours” rarely means two uninterrupted hours of playback. A reliable shortlist converts a calendar window into a conservative budget before comparing titles.

## Calculate usable playback time

Use this worksheet:

| Component | Minutes |
|---|---:|
| Total session window |  |
| Setup and source check | − |
| Final decision | − |
| Planned break | − |
| Likely interruption allowance | − |
| Finish margin | − |
| **Usable playback budget** | **=** |

Choose allowances from the real household context rather than copying a generic number. If the finish time is flexible, record that explicitly instead of hiding it inside an oversized margin.

## Filter on the budget, not the clock window

Apply a runtime ceiling at or below the usable playback budget. Start slightly broader if runtime metadata is incomplete, then verify finalists manually.

EIDR lists approximate length among core identifying data, which is a useful reminder that duration supports identity and planning. “Approximate” also means the displayed value should be checked against the actual version used.

## Verify the exact version

For each candidate, record:

- cut or edition label;
- displayed runtime;
- source of the runtime;
- current available version;
- audio and subtitle setup needs;
- whether an introduction, credits discussion, or break belongs in the session.

Use [the alternate-cut guide](/blog/choose-between-alternate-cuts/) when two versions share a title but not a runtime. Do not choose a movie by the shorter record and then start the longer cut.

## Build three runtime bands

Divide valid candidates relative to the current budget:

- **Comfortable:** leaves the full finish margin.
- **Exact fit:** uses most of the budget but still includes planned transitions.
- **Fallback:** meaningfully shorter and ready if the session starts late.

These are session-specific bands, not permanent movie categories.

| Candidate | Verified cut | Runtime | Band | Required tracks | Ready now? |
|---|---|---:|---|---|---|
|  |  |  |  |  |  |

## Rank after eligibility

Once every candidate fits, sort or compare by category, familiarity, group preference, or personal priority. Runtime has already done its job and should not automatically make the shortest movie the winner.

For a broader group decision, feed the valid candidates into [the movie-night shortlist funnel](/blog/plan-personal-movie-night/).

## Handle start-time slippage

Set a decision checkpoint. If playback has not started by then, recalculate rather than pretending the original budget still applies. Move to the shorter fallback or reschedule the preferred title.

When planning several sessions, [the weekend queue workflow](/blog/create-weekend-movie-queue/) assigns movies to time and energy slots without packing the schedule to its theoretical maximum.

## Preserve progress only when needed

If interruption is acceptable, decide the planned stopping rule in advance. For a movie intended as one sitting, use the conservative budget. If a break across days is acceptable, record the exact version and last confirmed point so resumption does not become guesswork.

Dublin Core includes `extent` and temporal properties for describing size and time characteristics. In a personal workflow, keep runtime, session budget, and viewing progress as separate facts.

Norva may expose runtime, versions, progress, and compatible authorized sources in one interface, but the connected source determines actual version availability and metadata. Verify the selected item before starting.

## Common mistakes and limitations

- Using the whole calendar window as playback time.
- Treating runtime as exact without checking the version.
- Forgetting setup, breaks, and a finish margin.
- Keeping only exact-fit candidates.
- Sorting by runtime before applying must-haves.
- Assuming a late start will recover itself.

## Frequently asked questions

### How large should the finish margin be?

Choose it from the consequences of running late and the household's interruption pattern. There is no universal number.

### Should credits count in runtime?

Use the runtime of the selected version and decide whether the session includes the full credits. Keep that rule consistent.

### What if runtime metadata is missing?

Treat it as unknown, verify another source or the version directly, and do not claim that it fits until confirmed.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [EIDR Frequently Asked Questions](https://www.eidr.org/faq)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Features](https://norva.tv/#features)
