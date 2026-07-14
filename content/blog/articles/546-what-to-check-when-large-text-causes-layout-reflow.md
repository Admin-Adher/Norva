---
content_id: "NVB-546"
title: "What to Check When Large Text Causes Layout Reflow"
seo_title: "Large Text and Media Interface Reflow Checks"
meta_description: "Check large-text reflow across navigation, cards, filters, dialogs, player controls, wrapping, clipping, scrolling, focus, and state continuity."
slug: "what-to-check-when-large-text-causes-layout-reflow"
canonical_url: "https://norva.tv/blog/what-to-check-when-large-text-causes-layout-reflow/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "accessibility-checklist"
topic_cluster: "Visual Comfort & Accessibility"
search_intent: "large text media layout reflow"
funnel_stage: "retention"
primary_question: "What should be checked when large text causes a media interface to reflow?"
supporting_questions:
  - "Which layout failures can hide information or controls at larger text settings?"
  - "How can a reflow boundary be documented without asking the viewer to reduce text?"
audience:
  - "Viewers using larger text settings"
  - "Product teams auditing media interface reflow"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/terms; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A task-based reflow check for larger text across navigation, content, overlays, player controls, focus, scrolling, and state continuity."
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
parent_pillar: "/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/"
related_articles:
  - "/blog/how-to-review-text-scaling-on-a-mobile-interface/"
  - "/blog/how-browser-zoom-changes-a-media-interface/"
  - "/blog/legibility-and-readability-two-different-viewing-problems/"
cta:
  label: "Explore Norva's Interface Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "large-text reflow boundary matrix"
  summary: "A task matrix records the first text setting at which each interface region wraps, clips, overlaps, scrolls in two directions, hides a control, obscures focus, or loses state."
  methodology: "The reviewer fixes device, viewport, language, content, and input; completes a baseline task; increases one supported text or zoom setting at a time; and repeats the same task without reducing the preference."
  asset_urls: []
---
# What to Check When Large Text Causes Layout Reflow

> **In short:** When text becomes larger, check whether every label, control, message, and content region remains understandable and operable. Follow an end-to-end task through navigation, cards, filters, details, dialogs, and player controls. Record wrapping, clipping, overlap, hidden actions, two-dimensional scrolling, covered focus, and lost state at the first failing setting. Do not solve the problem by asking the viewer to reduce text.

Reflow is not simply a visual change. It can alter order, reachability, and the relationship between a label and its control. A screenshot can look crowded while the task still works, or look tidy because essential information has disappeared.

## Establish one controlled baseline

Record device, operating system, app or browser version, viewport or orientation, language, content, account state, input method, and the exact enlargement mechanism. Complete the task at the viewer's normal setting first.

Change only one supported text, display, or zoom setting during a comparison. Browser zoom and mobile system text scaling are different mechanisms; use [the browser zoom review](/blog/how-browser-zoom-changes-a-media-interface/) and [the mobile text-scaling review](/blog/how-to-review-text-scaling-on-a-mobile-interface/) for their specific boundaries.

## Follow a complete media task

At every relevant setting:

1. read and use primary navigation;
2. open search and enter a realistic long query;
3. scan cards, badges, and metadata;
4. open filters or sorting and change one value;
5. read a detail page and its actions;
6. open, operate, and close a dialog;
7. expose player controls and captions;
8. return to the original context.

This sequence reveals failures that an isolated heading test misses.

## Inspect fixed dimensions and rigid rows

Look for containers whose height does not grow with text, buttons whose labels escape their boundaries, badges that cover titles, and horizontal rows that hide controls. Check whether wrapping preserves the connection between label, value, and action.

Truncation needs a reliable way to reveal the full meaning. An ellipsis alone is not evidence that the information remains available.

## Check overlays and transient states

Open menus, dialogs, tooltips, validation errors, loading and empty states, notices, and player overlays. Larger text may make a modal taller than the viewport or push its close action behind a fixed footer. Confirm every message remains readable long enough and every required action remains reachable.

After dismissal, verify focus and scroll return to a logical place.

## Original evidence: reflow boundary matrix

| Region and task | Baseline | Larger setting | First failure | Information lost? | Action reachable? | State preserved? |
|---|---|---|---|---|---|---|
| Navigation | Result | Result | Setting/none | Yes/no | Yes/no | Yes/no |
| Search and keyboard | Result | Result | Setting/none | Yes/no | Yes/no | Yes/no |
| Detail and dialog | Result | Result | Setting/none | Yes/no | Yes/no | Yes/no |
| Player and captions | Result | Result | Setting/none | Yes/no | Yes/no | Yes/no |

Keep one row per context. A failure at one viewport should not be generalised to every supported device.

## Review scrolling and reading order

Identify where horizontal scrolling begins and whether ordinary reading requires movement in two directions. Some specialised content can have exceptions under accessibility guidance, so document the component and applicable requirement instead of making a blanket claim.

Navigate by keyboard, remote, touch, or assistive input appropriate to the context. Visual reordering should not create an illogical focus order or send focus into covered content.

## Preserve meaning across variants

Test long titles, translated labels, multiple metadata badges, errors, unavailable states, and empty results. Short default copy can conceal a fragile layout. Use real authorised interface strings or privacy-safe test fixtures rather than invented product outcomes.

Larger text can improve character recognition while making grouping or sequence harder to follow. [The legibility and readability distinction](/blog/legibility-and-readability-two-different-viewing-problems/) helps classify both effects without reversing the user's preference.

## Report the boundary precisely

Include the exact setting, task, region, expected outcome, observed reflow, lost information, input method, workaround, and privacy-safe evidence. Capture enough surrounding layout to show whether an element moved, became covered, or disappeared.

Avoid declaring accessibility conformance from this informal check. Current Norva platform behavior and controls must be verified through official product information and supported-context testing.

## Frequently asked questions

### Is wrapping itself a failure?

No. Wrapping is often the mechanism that preserves content. It becomes a barrier when meaning, operation, order, or visibility is lost.

### Should a user reduce text when a dialog overflows?

No. Record the supported setting and fix the dialog's reflow or scrolling behavior rather than overriding the preference.

### Is browser zoom equivalent to mobile text scaling?

No. They can affect typography, containers, and effective layout space differently, so report the mechanism tested.

## Your next step

[Explore Norva's interface features](https://norva.tv/#features)

## Sources

- [W3C: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
- [W3C: Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html)
- [Norva Features](https://norva.tv/#features)
