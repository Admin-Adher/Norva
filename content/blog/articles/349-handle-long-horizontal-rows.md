---
content_id: "NVB-349"
title: "How D-Pad Focus Should Behave in Long Horizontal Rows"
seo_title: "D-Pad Focus in Long Horizontal TV Rows"
meta_description: "Handle long TV rows with visible focus anchoring, controlled scrolling, per-row memory, predictable vertical escape, stable item identity, and clear edges."
slug: "handle-long-horizontal-rows"
canonical_url: "https://norva.tv/blog/handle-long-horizontal-rows/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "navigation design guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should D-pad focus behave in a long horizontal TV row?"
supporting_questions:
  - "How should row scrolling reveal and anchor the focused item?"
  - "How should focus memory and vertical escape work across rows?"
audience:
  - "TV product designers and engineers"
  - "Norva teams implementing carousels and recommendation rows"
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
excerpt: "A focus-and-scroll contract for long TV rows that keeps the active card readable, remembers position, and preserves predictable movement between collections."
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
  - "/blog/navigate-edges-of-tv-grid/"
  - "/blog/preserve-focus-after-back/"
  - "/blog/size-recommendation-rows-tv/"
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
  type: "horizontal-row focus trace"
  summary: "A trace records item identity, viewport position, scroll delta, focus cue visibility, row memory, vertical destination, and edge outcome across long and dynamically changing rows."
  methodology: "Reviewers navigate one step at a time and with key repeat through rows of varied lengths, reverse direction, leave and re-enter each row, open and return from details, and repeat after item mutations."
  asset_urls: []
---

# How D-Pad Focus Should Behave in Long Horizontal Rows

> **In short:** Move focus one item per deliberate Left or Right step, reveal the destination before it can be activated, and keep enough neighbouring context to show direction. Remember position per row, define vertical entry and exit rules, and make the first and last edges explicit. Scrolling should support focus, never race or replace it.

Long rows appear simple because they use one axis, but they combine spatial navigation, virtualization, asynchronous artwork, variable labels, and viewport movement. Without a contract, focus can disappear, jump several items, or return to the wrong collection.

## Make focus the source of truth

The focused item should determine which part of the row is visible. Do not maintain an independent carousel selection that can drift away from keyboard or remote focus. After each accepted input:

1. choose the next valid item by stable identity;
2. update focus;
3. reveal it fully inside the row viewport;
4. update any related detail preview;
5. accept the next state transition.

These steps may be visually animated, but the logical destination must be deterministic. Fast key repeat should not leave a long queue of animations after input stops.

## Use a stable visual anchor

Near the center of a long row, keep the focused card within a consistent viewing zone while cards move around it. At the first and last items, let the row settle naturally so the edge is visible. This balance maintains context without making focus feel pinned unnaturally at every position.

Show at least part of the next card only when that preview genuinely signals more content and does not create a false focus cue. Once the partial card receives focus, reveal its artwork, label, and indicator before activation.

## Scroll only the owning row

Left and Right should move within the horizontal collection. Up and Down should leave it according to the page's region map. Avoid a single key press scrolling both the row and the page, because the destination then moves on two axes.

If focused-card scaling or metadata expansion changes row height, keep neighbouring rows stable. The [recommendation-row sizing guide](/blog/size-recommendation-rows-tv/) explains why a compressed row can hide both focus and titles.

## Remember position independently for each row

Store a stable focused item or row offset for Continue Watching, recommendations, genres, and other collections separately. When viewers move Down to another row and later return Up, restore the prior valid target rather than always entering at item one.

If the remembered item disappears, use a nearby sibling, then the row's stable entry anchor. Apply the semantic method from [preserving focus after Back](/blog/preserve-focus-after-back/) when a card opens a detail screen.

## Define vertical alignment rules

Moving between rows of different card widths or lengths requires a policy. Preserve the closest visible column, remember the destination row's last focus, or use an explicit entry item. Prioritize row memory when it reflects a recent journey; otherwise, a visually aligned card is a reasonable fallback.

Test short rows beneath long ones. Down from item twelve cannot map to an absent twelfth card. Choose the nearest valid item or a stable row anchor, then verify that Up produces a sensible reverse route.

## Make row edges unambiguous

At the first item, Left may stop or enter an adjacent sidebar through a documented transition. At the final item, Right usually stops unless the row is deliberately circular or offers a visible “See all” destination. Do not wrap invisibly to item one.

Use the broader [TV grid-edge policy](/blog/navigate-edges-of-tv-grid/) for stop, reveal, wrap, and region-transition decisions.

## Survive loading and content mutation

Artwork arriving late must not change card bounds or reset focus. Adding a new item before the focused item should preserve its identity, not its old numerical index. Removing the target should invoke the sibling fallback without sending focus to the page body.

For virtualized rows, ensure the focused or active descendant remains represented correctly and is scrolled into view. Recalculate geometry after layout changes, but do not interrupt a valid current focus simply because more items arrived.

## Build a row test trace

Record row identity, start item, key, expected item, actual item, visible position, scroll delta, detail update, and edge result. Run one-step movement, rapid repeat, reversal, vertical exit and return, detail and Back, first and last edges, one-item rows, missing artwork, and item removal.

Add these routes to the [complete remote QA guide](/blog/remote-dpad-navigation-qa/) so row changes do not regress the page graph.

## Common mistakes and limitations

- Letting scroll position and focus selection diverge.
- Moving multiple logical items for one key press.
- Focusing a card before its identity is visible.
- Sharing one remembered index across all rows.
- Scrolling the row and page together.
- Wrapping from last to first without a visible model.
- Restoring a numerical index after items reorder.

## Frequently asked questions

### Should the focused card always stay centered?

No. A stable central zone helps during long travel, but the first and last items should reveal the collection boundaries naturally.

### What should Up or Down preserve between rows?

Prefer the destination row's recent focus when valid; otherwise use visual alignment or an explicit row anchor, according to the documented page contract.

### Can long rows use virtualization?

Yes, provided focus identity, accessibility state, scrolling, restoration, and edge behavior remain correct as items mount and unmount.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [Norva Features](https://norva.tv/#features)
