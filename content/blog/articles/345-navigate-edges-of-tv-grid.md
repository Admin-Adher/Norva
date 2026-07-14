---
content_id: "NVB-345"
title: "What Should Happen at the Edge of a TV Grid?"
seo_title: "What Should Happen at a TV Grid Edge?"
meta_description: "Define TV grid-edge behavior by visual expectation and task: stop, reveal more, enter a nearby region, or wrap only when the destination remains predictable."
slug: "navigate-edges-of-tv-grid"
canonical_url: "https://norva.tv/blog/navigate-edges-of-tv-grid/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "navigation design guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "What should D-pad navigation do at the edge of a TV grid?"
supporting_questions:
  - "When should focus stop, wrap, reveal content, or enter another region?"
  - "How should incomplete rows and dynamic grids behave?"
audience:
  - "TV product designers and engineers"
  - "Norva teams defining grid navigation"
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
excerpt: "A decision framework for stopping, wrapping, revealing, or crossing regions at regular and incomplete TV grid boundaries."
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
  - "/blog/move-between-sidebar-and-content/"
  - "/blog/handle-long-horizontal-rows/"
cta:
  label: "Preview Norva's TV Navigation"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "TV grid-edge policy matrix"
  summary: "A policy matrix assigns each grid boundary an expected stop, reveal, wrap, or region transition based on visible geometry, task continuity, and reverse-path clarity."
  methodology: "Reviewers test every edge from complete and incomplete rows with one-key presses, altered card counts, partially visible content, and layout changes, recording destination and reverse route."
  asset_urls: []
---

# What Should Happen at the Edge of a TV Grid?

> **In short:** Choose edge behavior from the visible layout and task. Stop when the grid visibly ends, reveal more when content continues, enter a clearly adjacent region through an explicit anchor, and wrap only when the jump is obvious and consistent. Never let nearest-rectangle math send focus to a surprising distant control.

Grid edges are not empty implementation details. They tell viewers whether a collection continues, whether another region is available, and whether reversing direction will undo the move.

## Choose among four explicit policies

| Policy | Use when | Required feedback |
|---|---|---|
| Stop | The collection visibly ends | Focus stays clear on the boundary item |
| Reveal more | Off-screen items continue in that direction | Destination scrolls fully into view |
| Enter region | A distinct region is visually adjacent | Stable entry anchor and reverse route |
| Wrap | The circular relationship is obvious | Consistent, non-disorienting destination |

No single policy fits every boundary. A horizontal carousel may reveal more to the Right but stop at its final item. A grid may move Left into a sidebar from its first column. A dialog action row may stop rather than jump to the opposite end.

## Make visual geometry and routing agree

If focus moves Up, the destination should appear above or represent a clearly documented region transition. A diagonal jump across several cards feels broken even if a spatial algorithm selects the nearest center point.

Define explicit anchors between heterogeneous regions. Within a regular grid, geometry may handle neighbours, but it still needs constraints so headers, hidden controls, and detail panels do not win accidentally. The [focus-trap diagnostic](/blog/diagnose-tv-focus-trap/) can identify when no valid candidate or the wrong candidate owns an edge.

## Handle incomplete final rows intentionally

Suppose the final row contains two cards under a five-column row. Pressing Down from column five cannot preserve the same column. Choose and document one fallback, such as the nearest valid item in the final row, the last item, or a stop on the prior row.

Whichever rule you select, test the reverse path. If Down moves from row two, column five to the last card in row three, Up should return predictably rather than jump to column two because the target's geometry changed.

## Distinguish a grid edge from a region edge

The first column can be both the grid's left edge and the entry to a sidebar. That cross-region path should use a stable sidebar anchor or remembered menu item. The [sidebar-to-content guide](/blog/move-between-sidebar-and-content/) explains how to retain region memory without expanding or shifting the navigation rail.

At the top edge, decide whether Up enters filters, a result header, or nothing. At the bottom, avoid sending focus to notifications or footer controls merely because they are the next focusable elements in document order.

## Keep partially visible targets honest

A partially visible card can signal continuation, but focus must reveal its identity and cue before activation. Scroll the owning container enough to show the destination fully while keeping spatial context. Do not let both the page and row scroll for the same key press.

For long horizontal collections, apply the row memory and anchoring rules in [handling long TV rows](/blog/handle-long-horizontal-rows/).

## Recalculate after content changes

Filtering, availability, localization, image loading, and responsive card counts can change the grid. Remove stale neighbour references and recompute the policy from stable identities and current regions. Test zero, one, one-full-row, one-plus-one, and large result counts.

When an item disappears under focus, use a deterministic sibling or region fallback. The boundary should not collapse focus into the document or global navigation.

## Build a boundary test table

For each screen, list top, right, bottom, and left policies, plus exception states. Record start target, key, expected destination, actual destination, whether scrolling occurred, and reverse outcome. Add cases for incomplete rows, loading completion, filter changes, and different screen widths.

This evidence turns “the edge feels strange” into a route that design and engineering can agree on and automate where appropriate.

## Common mistakes and limitations

- Wrapping every row by default.
- Allowing document order to define TV edges.
- Ignoring incomplete final rows.
- Moving to a target that remains partially hidden.
- Letting page and row scroll together.
- Fixing one card count with hard-coded coordinates.
- Testing the outward path but not the reverse.

## Frequently asked questions

### Should Left from the first card always enter the sidebar?

Only when the sidebar is the clear adjacent region and the product defines a stable reverse route.

### Is wrapping bad on TV?

Not inherently. Use it when circularity is visually clear and repeated testing shows that the destination is predictable.

### What should Down do from a missing column in the last row?

Use a documented nearest-valid or stop rule, then verify that Up restores a sensible origin. Consistency matters more than a universal formula.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [WAI-ARIA APG: Developing a Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [Norva Features](https://norva.tv/#features)
