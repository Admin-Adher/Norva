---
content_id: "NVB-357"
title: "How to Build a Direction-by-Direction D-Pad Test Matrix"
seo_title: "Build a Direction-by-Direction D-Pad Test Matrix"
meta_description: "Build a D-pad test matrix that records every start target, direction, expected destination, state, reverse route, edge rule, mutation, and reproducible result."
slug: "build-dpad-test-matrix"
canonical_url: "https://norva.tv/blog/build-dpad-test-matrix/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "QA methodology guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should a direction-by-direction D-pad test matrix be built?"
supporting_questions:
  - "Which columns make spatial navigation failures reproducible?"
  - "How should states, edges, mutations, and reverse routes be covered?"
audience:
  - "TV QA and engineering teams"
  - "Norva teams formalizing remote navigation tests"
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
estimated_reading_minutes: 8
excerpt: "A practical matrix schema that turns every remote direction, state transition, boundary, and data mutation into a reviewable test case."
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
parent_pillar: "/blog/remote-dpad-navigation-qa/"
related_articles:
  - "/blog/diagnose-tv-focus-trap/"
  - "/blog/prevent-key-repeat-overshoot/"
  - "/blog/report-remote-navigation-bug/"
cta:
  label: "Preview Norva's TV Navigation"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "directional QA matrix schema"
  summary: "A normalized matrix schema covers screen, region, state, start identity, one-key input, expected and actual destination, scroll, reverse path, evidence, severity, and automation status."
  methodology: "Reviewers inventory the focus graph, generate four directional cases per target plus Back and Select where relevant, deduplicate symmetric interiors, and retain explicit cases for boundaries and mutations."
  asset_urls: []
---

# How to Build a Direction-by-Direction D-Pad Test Matrix

> **In short:** Inventory every focus region and target type, then create a case for each meaningful Up, Down, Left, and Right edge from a controlled state. Record the exact start identity, expected and actual destination, scroll, reverse route, and evidence. Add separate cases for boundaries, overlays, loading, content mutation, Back, Select, and key repeat.

A matrix converts “navigation feels wrong” into a graph that design, engineering, and QA can review together. It also prevents happy-path testing from overlooking the last card, an incomplete row, or a filter after data refresh.

## Start with a focus-region inventory

List screens and regions: sidebar, header, search, filters, result band, grids, horizontal rows, detail actions, episodes, recommendations, keyboards, and dialogs. For each region, identify stable target types and entry anchors.

Do not begin with individual content titles. The matrix should survive changing data, while still storing stable item identity when a test runs.

## Use one row per directed edge

Recommended columns are:

| Field | Purpose |
|---|---|
| Case ID | Stable reference for regressions |
| Screen and state | Recreates page, data, and overlay state |
| Start region and target | Establishes visible focus |
| Input | One direction, Back, or Select |
| Expected destination | Defines the contract |
| Actual destination | Records the build result |
| Scroll or layout change | Exposes hidden movement |
| Reverse expectation | Tests route symmetry |
| Evidence and build | Makes failure replayable |

Use a single deliberate key press for baseline directional cases. Held-key behavior belongs in a related repeat case.

## Cover interiors without drowning in duplicates

Regular grid interiors often share one rule. Test representative middle items, then enumerate every boundary and exception: first and last columns, top and bottom rows, incomplete final row, one-item row, partially visible card, and cross-region anchors.

Do not deduplicate routes whose visual relationship differs. A Left edge into the sidebar and a Left move between cards are different contracts even if they use the same input.

## Add state dimensions deliberately

Run core edges in top-of-page, scrolled, filtered, loading, empty, error, detail-panel, and compact-header states. Add overlays, disabled controls, long labels, missing artwork, and different screen sizes where they can alter geometry.

For async pages, repeat before and after content arrives and after a target disappears. The [focus-trap diagnostic](/blog/diagnose-tv-focus-trap/) identifies the geometry and state evidence to capture.

## Verify reverse routes and boundaries

If Right moves from a filter into results, Left should return to the documented filter or region memory. If Down enters an incomplete last row, Up should produce a sensible origin. Not every route must be mathematically symmetric, but every exception needs a task-based reason.

At edges, expected destination can be “stay on current target.” That is a valid result when the boundary is visible and the wider task still has an escape.

## Include Back and Select as outcome cases

Directional coverage alone cannot prove the journey. Add Select for each control type and Back for every temporary or nested layer. Record state mutation, visible feedback, and restored focus.

Use the single-action rule from [making Select predictable](/blog/make-select-button-consistent/) and the layer model from [Back, Home, and Exit](/blog/back-home-and-exit-behavior/).

## Separate repeat and performance cases

After single-step routes pass, add tap, hold, release, reversal, and rapid alternating input. Record raw event count where available, accepted moves, visible focus, and final target. The [key-repeat guide](/blog/prevent-key-repeat-overshoot/) provides the necessary timing evidence.

## Decide what to automate

Automate deterministic target transitions, state restoration, disabled activation, and known edge policies where the client test environment supports them. Keep human review for viewing-distance focus visibility, perceived motion, remote timing, artwork stress, and display cropping.

Automation should report semantic target identities, not only coordinates. A passing coordinate can still point to the wrong card after data reorders.

## Maintain the matrix as a product contract

Link failures and fixes to case IDs. Update expectations only after design review, not to make a failing build appear green. Tag high-risk routes affected by layout, navigation engine, virtualization, or async changes and run them before broader regression.

The [complete remote QA guide](/blog/remote-dpad-navigation-qa/) provides the surrounding test strategy.

## Common mistakes and limitations

- Testing journeys without controlled starting focus.
- Recording coordinates instead of semantic targets.
- Omitting stay-in-place edge expectations.
- Deduplicating visually different cross-region routes.
- Testing outward moves without reverse routes.
- Mixing held-key behavior into single-step baselines.
- Updating expected results to match accidental behavior.

## Frequently asked questions

### Must the matrix contain four cases for every card?

Not when regular interior behavior is demonstrably equivalent. Keep representative interiors and enumerate every boundary, region transition, and exception.

### Is staying on the same target a valid expected result?

Yes, at a documented visible boundary. It is not valid when it creates a task trap with no other escape.

### What evidence should accompany a failure?

Include device and build, exact state, start target, one-key input, expected and actual target, plus a recording or focus overlay when available.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [WAI-ARIA APG: Developing a Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [Norva Features](https://norva.tv/#features)
