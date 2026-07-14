---
content_id: "NVB-356"
title: "How to Navigate Recommendation Rows With a D-Pad"
seo_title: "Navigate TV Recommendation Rows With a D-Pad"
meta_description: "Navigate TV recommendation rows with clear entry anchors, readable cards, stable memory, predictable vertical routes, honest edges, and Back restoration."
slug: "navigate-tv-recommendations-row"
canonical_url: "https://norva.tv/blog/navigate-tv-recommendations-row/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "navigation design guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should recommendation rows be navigated with a D-pad?"
supporting_questions:
  - "How should viewers enter, leave, and return to a recommendation row?"
  - "Which card identity and edge cues make long rows understandable?"
audience:
  - "TV product designers and engineers"
  - "Norva teams implementing related-content rows"
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
excerpt: "A D-pad contract for recommendation rows that connects the detail task to readable cards, remembers position, and returns viewers to their exact origin."
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
  - "/blog/size-recommendation-rows-tv/"
  - "/blog/handle-long-horizontal-rows/"
  - "/blog/preserve-focus-after-back/"
cta:
  label: "Preview Norva's TV Navigation"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "recommendation-row journey trace"
  summary: "A journey trace records entry from detail actions or episodes, horizontal travel, vertical escape, detail activation, Back restoration, and fallbacks for changing recommendations."
  methodology: "Reviewers enter rows from several regions, traverse first, middle, last, and partially visible cards, open details, return, alter row length, and record focus identity, viewport, and route symmetry."
  asset_urls: []
---

# How to Navigate Recommendation Rows With a D-Pad

> **In short:** Give every recommendation row a visible heading, a stable entry anchor, one-card directional steps, and a clear first and last edge. Keep focused card identity readable, remember position per row, define Up and Down destinations, and restore the exact originating recommendation after viewers return from details.

Recommendation rows are secondary discovery, but their navigation should not feel secondary. A compressed strip of artwork with no title or exit route becomes a visual decoration rather than a usable collection.

## Connect the row to the page task

Place the row after the primary detail or episode content it relates to, and give it a heading such as “More like this” when that description is accurate. The route into the row should come from the nearest meaningful region, not from a distant control selected by geometry.

Down from the preceding region can enter the row's remembered card or first valid card. Up should reverse to a stable target in that preceding region. Avoid diagonal jumps into the middle of an action row.

## Keep card identity visible on focus

Artwork alone is not enough, especially when images are dark, similar, missing, or cropped. Focus should reveal a readable title and any small amount of metadata needed for the recommendation decision. The cue must remain visible over stress artwork.

The [recommendation-row sizing guide](/blog/size-recommendation-rows-tv/) explains how row height protects artwork, text, and focus instead of collapsing them into a thin strip.

## Move one logical item per deliberate press

Left and Right should traverse valid cards in visual order. When the next card is partially off-screen, reveal its full identity and cue before activation. Do not allow the row's scroll position and logical focus to diverge.

For held keys and long collections, use the anchoring, memory, and repeat principles in [handling long horizontal rows](/blog/handle-long-horizontal-rows/). The row should stop promptly when input stops.

## Remember position per recommendation row

A detail screen can contain several collections, and each needs independent memory. Store row identity and stable item identity rather than one page-wide index. When the viewer moves away and comes back, restore the prior valid recommendation.

If that card disappears after data refresh, choose the nearest valid sibling, then the row anchor. Do not reset to the first recommendation simply because the row rerendered.

## Define vertical movement explicitly

Up and Down should reflect visible page structure. Moving Down from a recommendation may enter the next row, a related information block, or stop at the page boundary. Moving Up should return to the previous region or its remembered target.

When rows have different card widths, prioritize destination-row memory; otherwise use a visually aligned valid card. Test one-item and short rows beneath long ones.

## Make the final edge honest

At the first card, Left can stop or enter an adjacent global region only when that route is visibly clear. At the last card, Right should stop, reveal a verified “See all” action, or wrap only if circular behavior is explicit. Invisible wrapping to the beginning is difficult to predict.

## Restore context after opening a recommendation

Before opening its detail screen, capture page, row, item, and scroll state. Back should return to the same recommendation when it remains available. Apply the semantic origin method in [preserving focus after Back](/blog/preserve-focus-after-back/).

Nested recommendation journeys need a bounded history. A viewer can open a recommendation from another detail screen, but each Back press should return one meaningful level rather than collapsing to Home.

## Handle loading, empty, and duplicate content

Keep temporary loading shapes out of the focus graph. If recommendations are unavailable, remove the empty row or show a stable non-blocking message according to the verified design. Do not leave a focusable heading with no cards.

Define whether the current title can appear in its own recommendation row, and remove true duplicates by stable identity according to the content policy. Navigation should not rely on duplicated cards to fill space.

## Build a row journey test

Record entry origin, row identity, focused item, Left and Right destination, Up and Down destination, scroll delta, opened detail, Back destination, and fallback after row mutation. Repeat with long titles, missing artwork, one card, many cards, delayed data, and removed origins.

Add every route to the [complete D-pad QA guide](/blog/remote-dpad-navigation-qa/).

## Common mistakes and limitations

- Showing artwork without readable focused identity.
- Compressing the row until focus and titles disappear.
- Using one memory index for every row.
- Letting geometry choose diagonal vertical jumps.
- Wrapping invisibly from last to first.
- Returning from details to the first card or Home.
- Leaving loading shapes or an empty heading focusable.

## Frequently asked questions

### Should recommendation rows always start at the first card?

Use the first card on fresh entry, but restore recent row memory when viewers return during the same journey.

### Can a recommendation card open playback directly?

Only when its label and verified product contract make that outcome explicit. Opening details is safer when versions, episodes, or choices remain.

### What should happen when recommendations change during return?

Restore the stable item when possible, otherwise a nearby valid sibling or the row anchor while preserving page context.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [Norva Features](https://norva.tv/#features)
