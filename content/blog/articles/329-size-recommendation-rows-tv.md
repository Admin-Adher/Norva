---
content_id: "NVB-329"
title: "Why Recommendation Rows Need Enough Height on TV"
seo_title: "Why TV Recommendation Rows Need Enough Height"
meta_description: "Give TV recommendation rows enough height for artwork, titles, metadata, focus scale, progress, spacing, and full-text context without clipping or collapsing adjacent sections."
slug: "size-recommendation-rows-tv"
canonical_url: "https://norva.tv/blog/size-recommendation-rows-tv/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "design guide"
topic_cluster: "TV Interface Ergonomics"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Why do recommendation rows need sufficient height on TV?"
supporting_questions:
  - "Which content and focus dimensions determine row height?"
  - "How can collapsed recommendations be tested?"
audience:
  - "TV interface designers"
  - "Norva teams fixing visually collapsed related-title rows"
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
excerpt: "A content-led row-height formula that protects card identity, focus geometry, and navigation instead of squeezing recommendations into a leftover strip."
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
parent_pillar: "/blog/tv-interface-ergonomics-guide/"
related_articles:
  - "/blog/size-secondary-metadata-tv/"
  - "/blog/handle-long-horizontal-rows/"
  - "/blog/balance-tv-detail-panel/"
cta:
  label: "Preview Norva's TV Discovery"
  href: "https://norva.tv/#product-preview"
  intent: "awareness"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "TV recommendation row height budget"
  summary: "A vertical budget adds artwork, title, metadata, progress, focus expansion, internal spacing, and row-to-row separation across stress states."
  methodology: "Designers measure rendered component parts, reserve focus overflow, test long and missing text, traverse the row remotely, and compare against adjacent sections without defining a universal pixel height."
  asset_urls: []
---

# Why Recommendation Rows Need Enough Height on TV

> **In short:** A recommendation row needs space for the complete card, not just its artwork. Budget artwork, title, essential metadata, progress or badges, internal spacing, focus outline or scale, and separation from neighbouring sections. Fix collapsed rows by sizing from rendered content and focus states, then test long text and remote traversal.

When recommendations appear as thin slivers or compressed cards, their container was often sized from a mockup, an unloaded state, or artwork alone. The result removes identity and can clip remote focus.

## Build a vertical height budget

Add the maximum verified dimensions for:

| Component | Include |
|---|---|
| Artwork | Aspect-ratio height and fallback |
| Title | Reserved line count |
| Metadata | Essential comparison fields |
| Progress or badge | Only when the card role needs it |
| Internal gaps | Artwork-to-text and line spacing |
| Focus reserve | Outline, scale, shadow, elevation |
| Section separation | Heading and next-row breathing room |

Do not subtract fields when data is missing. Reserve stable geometry or use a defined sparse state.

## Size from real content states

Render short, long, translated, duplicate-prefix, and missing titles. Add one-line and two-line metadata, progress, unavailable badges, and selected states. Follow [the TV metadata hierarchy](/blog/size-secondary-metadata-tv/) so the row does not carry every detail.

W3C text-spacing guidance is a useful resilience check: user or system text spacing changes should not make content overlap. Focus-visible guidance reminds designers that remote focus must remain perceivable.

## Reserve focus expansion

A focused card may add an outline, shadow, or scale. The row and clipping container must leave room on every edge. Avoid overflow rules that hide the top ring or cut the first and last card.

If scale reflows neighbours or changes the row height, use a non-layout transform with reserved space or another focus cue. The indicator should not collide with the row heading.

## Coordinate row height with the detail screen

On a detail page, recommendations are secondary to identity and primary actions, but they still need a complete card. Reduce the number visible before reducing their ability to be read.

Use [the balanced detail-panel layout](/blog/balance-tv-detail-panel/) to allocate vertical space. If recommendations sit below episodes or variants, allow scrolling or section focus rather than squeezing all sections into one viewport.

## Preserve horizontal-navigation context

The focused card, row heading, and enough neighbouring cards should remain visible so Left and Right have a clear meaning. [The long-row D-pad guide](/blog/handle-long-horizontal-rows/) covers anchoring, edge behavior, off-screen movement, and Back restoration.

When the row scrolls horizontally, do not change vertical card size based on focused metadata. Put expanded details in a stable panel.

## Test loading and empty states

Skeletons and temporary loading surfaces must reserve the final row height. An empty recommendation section should disappear or show a useful stable message according to current design, not leave a tiny focusable remnant. Focus must never land on non-interactive loading shapes.

Norva’s exact recommendation card and row states require verification in the current TV release.

## Original evidence: row height budget

Measure every rendered component and focus reserve in default, focused, loading, long-title, missing-metadata, and unavailable states. Traverse from first to last card and into the next section, recording clipping, jumps, and unreadable identity.

The budget validates the tested component system. It does not establish one universal height across card types, screens, or languages.

## Common mistakes and limitations

- Sizing the container from artwork alone.
- Measuring before fonts or images load.
- Letting long titles increase only one card’s height.
- Clipping focus at row edges.
- Squeezing secondary rows to keep everything above the fold.
- Making loading surfaces shorter than final cards.

## Frequently asked questions

### Should every recommendation row use the same height?

Only rows with the same card role and content contract. Poster and landscape cards may need different budgets.

### Can metadata appear only when focused?

Yes, in a stable external detail region. Avoid changing individual card height on focus.

### What if there is not enough vertical space?

Prioritise sections, allow predictable scrolling, or reduce simultaneous rows. Do not hide card identity or focus.

## Your next step

[Preview Norva's TV Discovery](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [W3C: Understanding Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)
- [Norva Features](https://norva.tv/#features)
