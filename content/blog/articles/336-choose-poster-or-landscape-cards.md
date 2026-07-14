---
content_id: "NVB-336"
title: "Poster or Landscape Cards: Choose by Information Need"
seo_title: "Poster vs Landscape TV Cards: Choose by Need"
meta_description: "Choose poster or landscape TV cards by content identity, episode context, metadata needs, artwork quality, focus visibility, and row capacity."
slug: "choose-poster-or-landscape-cards"
canonical_url: "https://norva.tv/blog/choose-poster-or-landscape-cards/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "comparison guide"
topic_cluster: "TV Interface Ergonomics"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "When should a TV interface use poster cards or landscape cards?"
supporting_questions:
  - "Which information does each card shape support?"
  - "How should mixed artwork and missing assets be handled?"
audience:
  - "TV interface designers"
  - "Norva teams choosing cards for movies, series, episodes, and recommendations"
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
excerpt: "A role-based card decision that maps poster and landscape formats to work identity, episode context, metadata needs, and remote navigation."
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
  - "/blog/size-recommendation-rows-tv/"
  - "/blog/control-information-density-tv/"
  - "/blog/handle-long-horizontal-rows/"
cta:
  label: "Preview Norva's TV Library"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "poster-versus-landscape task matrix"
  summary: "A paired matrix compares item recognition, episode context, title fit, metadata, row height, neighbour visibility, focus reserve, and missing-artwork behavior for the same tasks."
  methodology: "Designers render matched candidates in both formats, test identification and navigation from viewing distance, and select by task evidence instead of a universal card preference."
  asset_urls: []
---

# Poster or Landscape Cards: Choose by Information Need

> **In short:** Use poster cards when vertical key art and work-level recognition dominate. Use landscape cards when scene context, episode identity, progress, or a short description matters. Choose one format per row role, reserve full focus geometry, and test real artwork plus missing and mismatched assets. Neither shape is universally better.

Card shape changes what can be recognised, how many neighbours remain visible, and how much vertical space a row consumes. It should follow the task, not the latest visual trend.

## Compare the natural strengths

| Need | Poster card | Landscape card |
|---|---|---|
| Film or series key art | Strong when source artwork is suitable | Can crop identity-heavy posters |
| Episode scene context | Often limited | Strong when still imagery is available |
| Progress and episode metadata | Less horizontal space | More room below or beside image |
| Dense work-level grid | More columns may fit | Fewer cards may remain visible |
| Short synopsis | Usually deferred | Can support a concise line in some roles |

These are design tendencies, not promises about source artwork or Norva’s current cards.

## Define the row’s information contract

State the row purpose: All Movies, Continue Watching, Episodes, Recommendations, or a shortlist. List identity and decision fields. DCMI terms for title, type, relation, format, and language help separate work and episode needs.

Use [the TV density guide](/blog/control-information-density-tv/) so the card does not carry deep detail that belongs in a stable panel.

## Test source artwork fit

Render actual authorised source assets. A poster cropped into landscape may remove the title or subject; a landscape still fitted into portrait may become unreadable. Define fallback surfaces and object-fit rules without pretending missing art exists.

Keep text identity outside the image. Artwork is supporting evidence, not the only label.

## Budget the whole row

Poster and landscape formats require different vertical budgets. Include title, metadata, progress, focus expansion, and section spacing. Use [the recommendation-row height budget](/blog/size-recommendation-rows-tv/) before choosing how many rows fit.

Do not reduce landscape row height until cards collapse or poster width until titles become indistinguishable.

## Keep spatial behavior consistent

Within one row, cards should share focus geometry and baseline. Mixed shapes can create ambiguous Up and Down targets. If formats change between rows, make headings and vertical spacing clearly signal the new region.

Run long rows through [the horizontal D-pad behavior guide](/blog/handle-long-horizontal-rows/), including first, middle, last, partially visible, and loading cards.

## Use a matched task test

Render the same representative items as poster and landscape cards. From viewing distance, ask reviewers to identify work or episode, progress, version cue, and next action. Traverse the row and move to adjacent sections.

Record misidentification, clipped focus, long-title failure, missing-art fallback, and wrong directional jump. Do not combine preference ratings with task accuracy without explaining the method.

Norva’s actual card roles and artwork availability require current-release verification.

## Original evidence: task matrix

Create rows for movies, series, episodes, Continue Watching, and recommendations, and columns for both formats. Mark Pass, Fail, or Unknown for identity, metadata, focus, row budget, and fallback.

The matrix supports a role-specific decision. It does not establish one card shape as universally more usable.

Repeat the comparison with long titles, missing artwork, multiple seasons, watched progress, and localized labels. A card choice is robust only when its identity and focus treatment survive those ordinary content stresses without changing the row's navigation model.

## Common mistakes and limitations

- Choosing a card only from one beautiful asset.
- Cropping source posters without identity fallback.
- Mixing shapes inside one spatial row.
- Measuring artwork but not metadata and focus.
- Using posters for episode tasks without episode context.
- Treating card count as the only density goal.

## Frequently asked questions

### Can movies use landscape cards?

Yes, when the row task and available artwork support identity and comparison. Verify with real content.

### Should episodes always use landscape stills?

Not always. Missing or spoiler-sensitive imagery may require another treatment; preserve episode text identity.

### Can a focused poster expand into landscape?

That transformation can move spatial targets and complicate navigation. Prefer a stable detail region unless testing supports it.

## Your next step

[Preview Norva's TV Library](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Features](https://norva.tv/#features)
