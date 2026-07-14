---
content_id: "NVB-326"
title: "How to Keep Secondary Metadata Readable on TV"
seo_title: "Keep Secondary Metadata Readable on TV"
meta_description: "Keep TV metadata readable by limiting fields, using a clear type hierarchy, protecting contrast and spacing, revealing full focused context, and testing from viewing distance."
slug: "size-secondary-metadata-tv"
canonical_url: "https://norva.tv/blog/size-secondary-metadata-tv/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "design guide"
topic_cluster: "TV Interface Ergonomics"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can secondary metadata remain readable on a TV interface?"
supporting_questions:
  - "Which metadata belongs on cards versus detail panels?"
  - "How should type, contrast, and spacing be tested at viewing distance?"
audience:
  - "TV interface designers"
  - "Norva teams reviewing metadata readability"
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
excerpt: "A role-based metadata hierarchy that preserves identity and comparison cues without shrinking text or overloading TV cards."
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
  - "/blog/control-information-density-tv/"
  - "/blog/handle-title-truncation-tv/"
  - "/blog/balance-tv-detail-panel/"
cta:
  label: "Preview Norva's TV Experience"
  href: "https://norva.tv/#product-preview"
  intent: "awareness"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html"
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "TV metadata legibility ladder"
  summary: "A component inventory ranks each metadata field by task importance and tests it in default, focused, selected, long, and missing states from viewing distance."
  methodology: "Reviewers identify one card comparison task, remove nonessential fields, render the remaining hierarchy over varied backgrounds, and record reading errors without claiming a universal font size."
  asset_urls: []
---

# How to Keep Secondary Metadata Readable on TV

> **In short:** Show only metadata needed to identify or compare the focused item. Give title, progress, version, and access-critical fields a clear hierarchy; defer the rest to a stable detail panel. Protect type size, contrast, line height, and spacing instead of shrinking copy to fit. Validate every state from the intended viewing position.

Secondary does not mean disposable. A year, episode, language, or progress cue may determine whether a card is the right choice, even though it should not compete visually with the title and primary action.

## Rank fields by the current task

Create three tiers:

| Tier | Question | Typical fields |
|---|---|---|
| Identity | Which item is this? | Title, season, episode, release context |
| Decision | Is it suitable now? | Progress, duration, language, subtitle or version cue |
| Deep detail | Do I need more context? | Full synopsis, creators, complete technical metadata |

The exact fields depend on the page. A Continue Watching card needs progress and episode identity; a recommendation card may need relationship and version cues.

Use [the TV information-density method](/blog/control-information-density-tv/) before changing type size. Removing duplication is safer than making every field smaller.

## Build a deliberate type hierarchy

Define styles by role, not by arbitrary visual variation. The title must remain dominant, decision metadata next, and supporting context last. Maintain enough line height and spacing for labels to remain distinct when viewed from across the room.

W3C contrast and text-spacing guidance provides useful web baselines. Android TV app quality guidance reinforces designing specifically for TV and remote operation. A numeric desktop token is not automatically suitable for a living-room screen.

## Protect contrast over changing artwork

Place metadata on a controlled surface, gradient, or scrim rather than directly over unpredictable imagery. Test light, dark, detailed, and low-contrast artwork. Do not reduce opacity until secondary text becomes decorative.

Focus can further change the background. Coordinate the metadata state with [focus contrast over artwork](/blog/focus-contrast-over-artwork/) so text and focus remain distinct.

## Reveal complete context on focus

Cards can reserve one or two lines for compact metadata, while a stable detail panel exposes the full title and critical fields for the focused item. Do not rely on pointer hover or a moving tooltip.

Follow [the long-title strategy](/blog/handle-title-truncation-tv/) for wrapping and truncation. Long metadata values need their own rules; a language or subtitle value should not become ambiguous merely to match card width.

## Keep geometry stable

Reserve a consistent metadata region across cards. Missing values should not collapse the card and move neighbouring focus targets. Use an honest fallback only when it helps identity; otherwise leave a reserved blank region or restructure the component.

In the detail view, [balance artwork, details, and actions](/blog/balance-tv-detail-panel/) so additional lines do not push the primary action out of its expected location.

## Run a distance-reading test

Use the intended TV, remote, and viewing position. Show cards with short, long, missing, translated, and conflicting metadata. Ask the reviewer to identify exact item, episode, progress, required language, and primary action without moving closer.

Record the field and state behind each error. Compare before and after one hierarchy change; do not publish a universal font-size claim from one room.

Norva’s current TV metadata and card states require verification in the released build.

## Original evidence: legibility ladder

Inventory each field, its tier, component, default style, focused style, background condition, and observed reading result. Have a second reviewer complete the same comparison task without seeing the tier labels.

The ladder validates a particular task and environment. It does not prove readability for every viewer, screen, distance, language, or visual ability.

## Common mistakes and limitations

- Shrinking all metadata to preserve card count.
- Using low opacity to signal secondary importance.
- Placing text directly over uncontrolled artwork.
- Letting missing values change card height.
- Treating every page as needing the same fields.
- Testing only short English strings at desk distance.

## Frequently asked questions

### Should every card display year and genre?

Only when those fields help identify or compare items in that page’s task. Defer unused fields.

### Can focused cards show more metadata?

Yes, preferably in a stable contextual region that does not resize the grid or obscure neighbours.

### Is contrast enough to ensure readability?

No. Type size, spacing, viewing distance, background detail, hierarchy, and content length also matter.

## Your next step

[Preview Norva's TV Experience](https://norva.tv/#product-preview)

## Sources

- [W3C: Understanding Contrast Minimum](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [W3C: Understanding Text Spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html)
- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [Norva Features](https://norva.tv/#features)
