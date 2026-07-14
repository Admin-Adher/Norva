---
content_id: "NVB-930"
title: "Check Series and Episode Structure During Onboarding"
seo_title: "Check Series Structure During Norva Onboarding"
meta_description: "Check a first Norva series sample for title identity, season grouping, episode order, specials, variants, metadata limits, and reproducible evidence."
slug: "verify-first-series-structure"
canonical_url: "https://norva.tv/blog/verify-first-series-structure/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "series-structure-verification-guide"
topic_cluster: "Norva Onboarding"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I verify series and episode structure during Norva onboarding?"
supporting_questions:
  - "Which season, episode, and special-case checks should a first sample include?"
  - "How can I separate source metadata issues from interface presentation?"
audience:
  - "New Norva series viewers"
  - "Household catalog administrators"
author: { name: "", profile_url: "" }
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
excerpt: "A controlled series sample checks identity, season grouping, episode order, specials, variants, and source-derived metadata without scanning every episode."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/norva-onboarding-complete-journey/"
related_articles:
  - "/blog/norva-onboarding-complete-journey/"
  - "/blog/verify-first-catalog-sample/"
  - "/blog/verify-first-playback-session/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "series hierarchy verification map"
  summary: "A compact hierarchy map compares one known series, two seasons, boundary episodes, a special where applicable, and any distinct versions."
  methodology: "The administrator establishes the source baseline first, inspects selected hierarchy nodes under neutral filters, and records observed facts separately from suspected causes."
  asset_urls: []
---

# Check Series and Episode Structure During Onboarding

> **In short:** Verify one familiar series rather than scrolling through every show. Compare its identity, season count, first and last episode in two seasons, one special if available, and any distinct versions against the authorized source. Reset filters first, record exact differences, and keep observed structure separate from suspected causes.

Series organization has more layers than a movie catalog: work, season, episode, special, and sometimes source variants. A structured sample finds hierarchy problems without turning onboarding into a complete catalog audit. Begin with the [first catalog sample method](/blog/verify-first-catalog-sample/) so the import is stable and test conditions are recorded.

## Select a known series

Choose a non-sensitive series whose structure you can inspect through the source's own authorized workflow. Prefer one with at least two seasons. If the source offers specials or more than one version, include those features only when they are relevant.

Do not start with the most irregular series in the catalog. Establish a normal baseline first, then add a complex case if needed.

## Record the source hierarchy

Create a minimal source-side map: displayed series title, season labels, episode numbers at each selected boundary, and one short title cue. Record a special or alternate edition as a separate row. Avoid copying descriptions, artwork, or a complete episode list.

The source baseline describes what is supplied; it does not guarantee how incomplete or inconsistent metadata can be organized.

## Reset filters and grouping state

Clear active filters before looking for the series. Note the source selection, availability state, and version-grouping setting visible in the current interface. An episode hidden by a filter is not the same as a missing episode.

Change one control at a time. If the result appears only when grouping is disabled, preserve both states in the evidence.

## Confirm series identity

Compare title, year where available, broad genre, and recognizable episode context. Similar names can refer to different works, remakes, or editions. Do not infer identity from artwork alone.

Norva may organize and group variants using source-derived information. When identity data is weak, separate records can be a safer presentation than an incorrect merge.

## Inspect season boundaries

Open two seasons and inspect the first and last expected episode in each. Confirm that episode numbers and ordering are plausible. Also check whether switching seasons preserves a visible, understandable focus state on the current screen.

Record the smallest reproducible discrepancy, such as "Season 2 opens at Episode 4 under neutral filters." This is more actionable than "episodes are mixed."

## Treat specials explicitly

Specials may use different numbering or season labels depending on source metadata. If a special is expected, record its source label and where Norva presents it. Mark the check not applicable when the sample has no special.

Do not rename or move source records during the same test. That would change the baseline before the presentation has been documented.

## Check one playback handoff

Open a selected episode, verify that the details correspond to the row you chose, and start a brief session. Use the [first playback verification routine](/blog/verify-first-playback-session/) for a complete control test. Here, the objective is only to confirm that the chosen hierarchy node opens the intended episode.

Return to the series and note whether the season and episode context remains understandable. Do not generalize one successful handoff to every episode or device.

## Original evidence: series hierarchy map

| Node | Source baseline | Norva observation | Filter/grouping state | Result |
| --- | --- | --- | --- | --- |
| Series identity |  |  | Neutral | Pass / Difference |
| Season 1 boundaries | First and last selected episode |  | Neutral | Pass / Difference |
| Season 2 boundaries | First and last selected episode |  | Neutral | Pass / Difference |
| Special | Label and number |  | Neutral | Pass / Difference / N/A |
| Variant | Distinct edition |  | Grouped / Separate | Pass / Review |

This map is original evidence for one environment and timestamp. It is not a promise that every source uses the same hierarchy.

## Common structure-check mistakes

- Inspecting a partial import.
- Leaving availability or source filters active.
- Comparing only artwork or shortened titles.
- Assuming every special uses the same numbering convention.
- Changing source metadata before capturing the original state.
- Reporting a whole series as broken from one ambiguous row.

The [Norva onboarding journey](/blog/norva-onboarding-complete-journey/) shows where this result feeds into preferences, progress checks, and the first-week audit.

## Frequently asked questions

### Must every series have season folders?

No universal structure can be assumed. Presentation depends on source information and current supported behavior. Compare the selected item with its actual source baseline.

### What if two editions are grouped together?

Record each edition's distinguishing data and the grouping state. Do not delete either record. Review whether source identity information is sufficient and use official support if the grouping remains reproducibly incorrect.

### Should I check every episode during onboarding?

Usually not. Boundary episodes across two seasons plus one complex case provide a focused initial sample. Expand the audit only when a pattern justifies it.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
