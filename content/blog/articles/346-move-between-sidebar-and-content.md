---
content_id: "NVB-346"
title: "How Focus Should Move Between a Sidebar and Content"
seo_title: "Move TV Focus Between Sidebar and Content"
meta_description: "Move TV focus between a sidebar and content with explicit entry anchors, remembered region targets, clear reverse routes, and a stable compact navigation rail."
slug: "move-between-sidebar-and-content"
canonical_url: "https://norva.tv/blog/move-between-sidebar-and-content/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "navigation design guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should focus move between a TV sidebar and the main content?"
supporting_questions:
  - "Which anchors should control entry and return between regions?"
  - "How can a compact sidebar preserve context without expanding?"
audience:
  - "TV designers and engineers"
  - "Norva teams implementing compact sidebar navigation"
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
excerpt: "A region-memory model for predictable D-pad movement between a compact icon-and-label sidebar and changing page content."
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
  - "/blog/connect-filters-to-results-tv/"
  - "/blog/navigate-edges-of-tv-grid/"
  - "/blog/preserve-focus-after-back/"
cta:
  label: "Preview Norva's TV Navigation"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "sidebar-content transition map"
  summary: "A bidirectional transition map assigns sidebar entry items, page-region anchors, remembered content targets, and boundary fallbacks across page states."
  methodology: "Reviewers cross from every sidebar item into top, scrolled, filtered, empty, loading, and restored content, then reverse the route and compare focus, active-page state, and layout stability."
  asset_urls: []
---

# How Focus Should Move Between a Sidebar and Content

> **In short:** Treat the sidebar and page as separate focus regions connected by explicit anchors. Right from a selected sidebar item should enter the page's most useful current target; Left from the page boundary should return to the relevant sidebar item. Remember the last content target, keep active-page state distinct from focus, and do not expand the rail merely because it receives focus.

A sidebar is global navigation, while the content region contains the current task. Spatial proximity alone cannot express that relationship reliably across headers, filters, rows, and detail panels.

## Separate active page, focus, and selection

Three states can coexist:

- **Active page:** the destination currently displayed.
- **Focused item:** the control that will receive Enter.
- **Pending selection:** a menu item highlighted before activation, if the product uses that pattern.

Do not navigate just because focus enters a different sidebar item unless that behavior is deliberate and clearly signaled. Likewise, the active item's visual treatment must remain distinguishable from the focus cue.

## Define an entry anchor for every page state

Right from the sidebar should not always target the first DOM element. Map page states to meaningful anchors:

| Page state | Content entry anchor |
|---|---|
| Fresh page | Primary task or first meaningful control |
| Scrolled results | Last valid content focus |
| Filters active | Relevant filter or results anchor |
| Detail open | Safe primary action or identity region |
| Empty or error | Valid recovery action |

If the remembered target no longer exists, apply a nearby fallback. The [focus restoration contract](/blog/preserve-focus-after-back/) provides a reusable ladder.

## Return to the sidebar from visible boundaries

Left should enter the sidebar from a content target that visibly sits at the page's left boundary, not from every card in a grid. Otherwise, moving between adjacent cards may unexpectedly abandon the task.

When the transition occurs, focus the active page's sidebar item or a documented region memory. Right should then return to the content anchor, creating a reversible pair. Use the [TV grid-edge guide](/blog/navigate-edges-of-tv-grid/) to specify exceptions for incomplete rows and horizontal carousels.

## Keep the compact rail geometrically stable

Focus does not require a sidebar to widen, push the page, or hide text. A compact icon-and-label rail can use a clear outline, background, or luminance change while preserving fixed width. If additional descriptions are necessary, use a non-displacing treatment and verify that it does not cover content targets.

Stable geometry protects cached focus bounds and keeps card columns from shifting under the viewer. It also makes the reverse route visually understandable.

## Remember focus separately for each page

Store the last meaningful content target by page or navigation destination. Moving from Movies to Series and back should not reuse one global rectangle or index. Remember semantic item identity, region, filters, and row offset as appropriate.

Clear or replace memory when a new journey makes it irrelevant. A stale target from an earlier account state can create an invisible focus request or a jump deep into an unrelated list.

## Handle top, scrolled, and overlay states

Test entry while a compact header is active, results are scrolled, a detail panel is visible, and a dialog has just closed. A temporary overlay should restore focus to its opener before sidebar routes resume.

If a page scrolls when the sidebar receives focus, preserve the content position. Global navigation should not silently reset the current page unless the viewer activates a different destination.

## Connect filters and results explicitly

Pages with several filters need a separate internal route from filters to results. The sidebar should enter the page at the relevant current anchor, while the [filter-to-results pattern](/blog/connect-filters-to-results-tv/) determines movement within the task. Avoid using the sidebar as an escape from a broken filter region.

## Build a bidirectional transition test

For each sidebar item and page state, record sidebar start, Right destination, Left-return trigger, sidebar destination, second Right destination, and whether content scroll changed. Repeat with empty results, delayed loading, filtered data, and removed remembered items.

Also press Up and Down immediately after each transition. A correct entry target still fails if it cannot participate in the region's normal navigation.

## Common mistakes and limitations

- Expanding the sidebar and shifting content on focus.
- Treating active page and focus as the same state.
- Sending Right to the first DOM control everywhere.
- Sending Left to the sidebar from every grid column.
- Sharing one content memory across all pages.
- Resetting page scroll when the rail receives focus.
- Omitting the reverse route from sidebar to content.

## Frequently asked questions

### Should Right from a sidebar always enter the header?

No. It should enter the most useful target for the current page state, which may be a remembered result, filter, recovery action, or detail action.

### Must the sidebar expand on focus?

No. A fixed compact rail with icons, labels, and an unmistakable focus cue can preserve more content space and stable geometry.

### What should Left do inside a horizontal row?

Move to the previous item until the row's defined left boundary, then use the documented cross-region route if the sidebar is the intended neighbour.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [Norva Features](https://norva.tv/#features)
