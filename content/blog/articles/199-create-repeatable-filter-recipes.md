---
content_id: "NVB-199"
title: "How to Create Repeatable Filter Recipes for Common Choices"
seo_title: "Create Repeatable Media Filter Recipes"
meta_description: "Create repeatable media filter recipes with a named goal, scope, versioned conditions, requirement hierarchy, controls, fallback rules, and a verification date."
slug: "create-repeatable-filter-recipes"
canonical_url: "https://norva.tv/blog/create-repeatable-filter-recipes/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Filter Strategies"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can repeatable filter recipes be created for common media choices?"
supporting_questions:
  - "What information belongs in a reusable filter recipe?"
  - "How should a recipe handle changing metadata and empty results?"
audience:
  - "People who repeat the same media filtering tasks"
  - "Norva users documenting household or personal filter routines"
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
excerpt: "A versioned recipe contract makes recurring filter combinations reproducible, testable, and resilient to source or metadata changes."
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
parent_pillar: "/blog/media-filter-strategy-guide/"
related_articles:
  - "/blog/should-filters-persist/"
  - "/blog/reset-filters-preserve-context/"
  - "/blog/diagnose-empty-filter-results/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://guides.loc.gov/catalog/advanced-search"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "versioned filter recipe contract"
  summary: "A recipe contract records goal, scope, ordered conditions, semantics, requirement strength, controls, expected count band, fallback sequence, owner, and verification date."
  methodology: "Readers build the recipe from a clean baseline, validate each condition with controls, save an ordered specification, rehearse the fallback, and version changes after source or product updates."
  asset_urls: []
---

# How to Create Repeatable Filter Recipes for Common Choices

> **In short:** Give the recipe a specific decision goal, define profile and source scope, list conditions in a reproducible order, label each as required or optional, document include or exclude semantics, and add positive controls, an expected count band, and a fallback sequence. Date and version the recipe so changed metadata, sources, or product behavior do not silently alter its meaning.

A recipe is more than a screenshot of selected controls. It is a small operational contract that another person—or you in three months—can reproduce and verify.

## Start with a recurring decision

Good recipe goals are concrete:

- “Available family favorites with required subtitles.”
- “Short episodes for a weekday evening.”
- “Recently added items in one broad category.”

Avoid recipes named only after controls, such as “Year + language.” The goal explains why conditions exist and which ones can be relaxed.

## Fill the recipe contract

| Contract field | Record this |
|---|---|
| Name and version | Human-readable name, v1 |
| Decision goal | The recurring choice |
| Profile and source scope | Where it applies |
| Clean baseline | Search, category, and reset state |
| Ordered conditions | One filter per step |
| Semantics | Include/exclude, any/all, boundaries |
| Strength | Must-have or preference |
| Positive controls | Known records expected to match |
| Expected count band | A warning range, not a promise |
| Fallback sequence | What to relax first |
| Owner and checked date | Who verified it and when |

This contract is the original artifact. A product's saved-filter feature, if available, can implement it, but the written specification remains the audit trail.

## Build from a clean baseline

Use [the context-preserving reset](/blog/reset-filters-preserve-context/) to return to a known starting state. Record any stable preferences that remain after task filters are cleared.

Apply the first must-have and check one positive and one negative control. Record the result count. Repeat for each condition. Do not save a recipe whose individual steps have not been validated.

The Library of Congress advanced-search guidance demonstrates the value of field-specific and Boolean combinations. For a reusable recipe, document the fields and grouping explicitly instead of relying on their visual order.

## Separate requirements from preferences

A recipe should remain useful when current availability or metadata changes. Mark each condition:

- **Required:** removing it defeats the decision goal.
- **Preferred:** improves ranking or convenience.
- **Diagnostic:** used only to validate state and removed before use.

Whenever possible, turn preferences into sort order rather than exclusions. This prevents a routine choice from becoming overconstrained.

## Document semantics and boundaries

For every multi-select, record whether values use any or all. For a range, state whether endpoints are included. For availability, define source and refresh scope. For language, state whether the field applies to audio, subtitles, or a specific version.

Do not use “All” or “default” without defining it. Product defaults can change.

## Add controls and an expected band

A fixed expected count will become stale as the catalogue changes. Use a band or qualitative warning:

- zero means run the fallback and controls;
- unusually low means check hidden state and metadata;
- unusually high means one condition may not have applied.

Include at least one stable positive control when possible. If no appropriate control exists, record the limitation rather than inventing certainty.

## Write and rehearse the fallback

Define the removal order before the recipe fails:

1. Remove the weakest preference.
2. Remove the least reliable metadata condition.
3. Expand a narrow range.
4. Refresh or verify source scope.
5. Preserve must-haves and accept no current match.

Use [the empty-result rollback ladder](/blog/diagnose-empty-filter-results/) to diagnose rather than randomly edit the combination.

## Version the recipe

Increment the version when:

- a filter label or semantic changes;
- a source is added or removed;
- profile scope changes;
- the fallback changes;
- controls no longer behave as expected.

Record the reason and verification date. Do not overwrite prior meaning silently.

## Decide how it should persist

An explicitly saved recipe can reasonably survive sessions, but its application should remain visible and reversible. [The persistence decision guide](/blog/should-filters-persist/) helps choose profile, device, or account scope.

W3C notification guidance recommends status feedback and recovery routes. When a recipe is applied, show its name, active conditions, result count, and a clear action to edit or start fresh.

Norva may sync preferences and organise compatible sources a user is authorised to access, but recipe results depend on current source availability, metadata, and implemented filter behavior. Reverify after meaningful changes.

## Common mistakes and limitations

- Saving only a screenshot.
- Naming controls instead of the goal.
- Omitting scope and semantics.
- Treating an expected count as permanent.
- Lacking controls or a fallback.
- Editing a recipe without changing its version.

## Frequently asked questions

### How often should a recipe be checked?

Check after product, source, profile, or metadata changes, and whenever controls or counts behave unexpectedly.

### Can two people share one recipe?

Yes if scope, accessibility needs, profile state, and fallback are explicit. Otherwise create variants.

### Should a recipe automatically run every session?

Only when the user expects that behavior and restored state is clearly visible. Explicit selection is safer for task-specific recipes.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Library of Congress: Advanced Search](https://guides.loc.gov/catalog/advanced-search)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
