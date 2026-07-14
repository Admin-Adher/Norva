---
content_id: "NVB-943"
title: "How to Evaluate Norva for Cross-Screen Continuity"
seo_title: "Evaluate Norva Cross-Screen Continuity"
meta_description: "Evaluate Norva cross-screen continuity with controlled A-to-B-to-A tests for progress, favorites, preferences, item identity, navigation effort, and recovery."
slug: "evaluate-norva-cross-screen-continuity"
canonical_url: "https://norva.tv/blog/evaluate-norva-cross-screen-continuity/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "cross-screen-evaluation-guide"
topic_cluster: "Norva Evaluation & Comparison"
search_intent: "commercial"
funnel_stage: "consideration"
primary_question: "How can I evaluate Norva for cross-screen continuity?"
supporting_questions:
  - "Which progress, favorite, preference, and navigation tests should run in both directions?"
  - "How should intermittent and screen-specific results affect the decision?"
audience:
  - "Prospective multi-device Norva users"
  - "Households moving between TV, web, and mobile"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "Cross-screen continuity should be tested in both directions with fixed identity, measured state, navigation effort, and explicit recovery criteria."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/norva-evaluation-framework/"
related_articles:
  - "/blog/norva-evaluation-framework/"
  - "/blog/run-first-progress-sync-check/"
  - "/blog/norva-trial-evaluation-scorecard/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "cross-screen continuity benchmark"
  summary: "A three-trial bidirectional benchmark records progress accuracy, favorite state, preference behavior, item identity, navigation actions, failure recovery, and confidence."
  methodology: "The evaluator fixes account, profile, source, item version, screens, and tolerance, runs A-to-B and B-to-A workflows on three occasions, and scores only repeatable observations."
  asset_urls: []
---

# How to Evaluate Norva for Cross-Screen Continuity

> **In short:** Choose two supported screens you will actually use and hold the account, profile, source, item version, and network conditions constant. Test progress, favorites, one preference, item identity, and navigation effort from A to B and back again. Repeat on three occasions. A single successful handoff is encouraging, but a decision should reflect repeatability and recovery from stale state.

Cross-screen continuity means more than opening the same catalog on two devices. The household must be able to identify the same work, recover the expected profile context, continue at a useful position, and understand any delay or limitation.

Use the [Norva evaluation framework](/blog/norva-evaluation-framework/) to mark continuity as essential, desirable, or irrelevant before testing.

## Choose realistic screen pairs

Select a primary and secondary supported surface, such as TV and mobile or web and TV. Record device category, input method, app or browser surface, network context, and viewing distance where relevant.

Do not test an unused third device merely to increase coverage. A realistic pair produces evidence aligned with the purchasing decision.

## Freeze identity variables

Confirm the same Norva account, household profile, authorized source, catalog item, and media version on both screens. Similar titles and grouped variants can create a false match. Use a private shorthand to identify the item in the log.

Norva can keep catalog context, progress, favorites, and preferences across supported devices, while actual media and track availability remain source- and device-dependent.

## Define tolerances first

Before playback, define what counts as a useful progress match based on the time precision displayed by both surfaces. Also define the maximum navigation actions acceptable for finding and resuming the item. Do not create thresholds after seeing the result.

Avoid a universal synchronization-time promise. Record local observation times and any explicit current guidance instead.

## Test progress A to B

Create a distinctive position on A, exit normally, and record the time. On B, note the displayed position before opening and the actual position after resume. Classify the result as match, stale, missing, ahead, wrong item, or unknown.

The [first progress sync check](/blog/run-first-progress-sync-check/) offers a detailed baseline trace. This evaluation adds repeated trials and decision thresholds.

## Test favorites and preferences

Add one known item to Favorites on A, then inspect the icon and list on B. Remove it on B and inspect A. For one known multilingual or captioned item, set a supported profile preference and observe behavior on both screens.

Separate saved preference from track availability. The preferred track must exist in the selected version and be supported on the screen.

## Count navigation effort

Measure actions from the screen's normal starting state to the intended item and playback position. On TV, include directional moves and Back behavior; on mobile, include taps and interruptions; on web, include focus or pointer actions relevant to real use.

Record focus traps, accidental profile switches, filter confusion, and dead ends. Continuity fails in practice if synchronized state exists but is too difficult for the intended viewer to reach.

## Test stale-state recovery

If a result appears stale, use the normal supported refresh, navigation, or relaunch behavior once and count the recovery steps. Do not reset the account or source. A recoverable delay and an unexplained persistent mismatch should receive different scores.

Preserve sanitized evidence before any destructive change. Exclude credentials, source details, private titles, and notifications.

## Repeat on three occasions

Run the complete A-to-B-to-A sequence at different ordinary times. Keep the core identity variables fixed and record network context. Three trials do not prove universal performance, but they reveal whether the first result was an outlier.

Use the [trial evaluation scorecard](/blog/norva-trial-evaluation-scorecard/) to combine continuity with plan, privacy, and support decisions.

## Original evidence: continuity benchmark

| Metric | Trial 1 | Trial 2 | Trial 3 | Decision threshold | Outcome |
| --- | --- | --- | --- | --- | --- |
| Progress A to B |  |  |  |  |  |
| Progress B to A |  |  |  |  |  |
| Favorite add and remove |  |  |  |  |  |
| Preference behavior |  |  |  |  |  |
| Navigation actions |  |  |  |  |  |
| Recovery steps |  |  |  |  |  |

Mark unknown when evidence is incomplete. Do not convert an unsupported media case into a synchronization failure.

## Frequently asked questions

### Must both screens show identical layouts?

No. Continuity concerns understandable state and workflow, not pixel-identical presentation. Evaluate whether each surface enables the intended task efficiently.

### What if progress works but preferences do not?

Score them separately. Confirm profile, media version, track availability, and device support before classifying the preference result.

### Is one successful test enough?

It establishes feasibility under one set of conditions. Repeat ordinary bidirectional trials before relying on the workflow for a decision.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
