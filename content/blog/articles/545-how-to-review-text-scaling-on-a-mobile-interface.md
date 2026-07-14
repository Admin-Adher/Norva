---
content_id: "NVB-545"
title: "How to Review Text Scaling on a Mobile Interface"
seo_title: "How to Review Mobile Interface Text Scaling"
meta_description: "Review mobile text scaling across navigation, cards, filters, metadata, dialogs, player controls, keyboard states, orientation, clipping, and task completion."
slug: "how-to-review-text-scaling-on-a-mobile-interface"
canonical_url: "https://norva.tv/blog/how-to-review-text-scaling-on-a-mobile-interface/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "mobile-audit"
topic_cluster: "Visual Comfort & Accessibility"
search_intent: "mobile text scaling media UI"
funnel_stage: "retention"
primary_question: "How should text scaling be reviewed on a mobile media interface?"
supporting_questions:
  - "Which navigation, content, dialog, player, keyboard, and orientation tasks should be tested?"
  - "How can scaling failures be documented without resetting user preferences?"
audience:
  - "Viewers using larger mobile text settings"
  - "Product teams auditing mobile media interfaces"
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
estimated_reading_minutes: 6
excerpt: "A real-device mobile text-scaling audit for navigation, cards, filters, dialogs, player controls, keyboard states, orientation, and reflow."
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
  - "/blog/what-to-check-when-large-text-causes-layout-reflow/"
  - "/blog/legibility-and-readability-two-different-viewing-problems/"
  - "/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/"
cta:
  label: "Explore Norva's Mobile Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "mobile text-scale task ladder"
  summary: "A real-device ladder records text recognition, wrapping, clipping, control reachability, keyboard overlap, orientation behavior, and end-to-end task completion at baseline and larger system settings."
  methodology: "The reviewer preserves the user's normal setting, tests one or more larger supported system steps with consent, restarts only when the platform requires it, and separates app from browser behavior."
  asset_urls: []
---
# How to Review Text Scaling on a Mobile Interface

> **In short:** Test on a real supported phone with the user's normal text setting, then one or more larger supported system steps with consent. Run the same navigation, search, card, detail, dialog, and player tasks. Record clipping, overlap, hidden controls, keyboard obstruction, lost information, and broken orientation. Do not tell users to reduce text to make the interface work.

Mobile text scaling can enlarge labels without enlarging every container proportionally. The resulting reflow reveals fixed heights, rigid rows, truncated buttons, and controls that depend on short text.

## Preserve the baseline

Record device, operating system, app or browser version, orientation, system text setting, display scaling where relevant, language, page, and input method.

Use the person's ordinary settings first. Do not reset accessibility preferences for convenience.

## Choose an end-to-end task

Test:

1. read and use primary navigation;
2. open search and type with the on-screen keyboard;
3. scan cards and metadata;
4. use filters or sorting;
5. open a detail page and read actions;
6. open and dismiss a dialog;
7. open player controls and captions;
8. return without losing context.

## Increase text through supported settings

Use exact platform labels and record them. If the app must restart for the change, note that boundary and verify the same account state safely.

Do not translate named settings into percentages the platform does not expose.

## Original evidence: scale ladder

| Setting | Navigation | Cards/metadata | Search/keyboard | Dialog | Player | Orientation | Task complete? |
|---|---|---|---|---|---|---|---|
| Normal | Result | Result | Result | Result | Result | Result | Yes/no |
| Larger | Result | Result | Result | Result | Result | Result | Result |
| Largest tested | Result | Result | Result | Result | Result | Result | Result |

Record the first failing element and whether content remains reachable.

## Check wrapping and fixed containers

Look for cropped headings, buttons that show only icons without names, overlapping metadata, fixed cards that hide the second line, and bottom navigation labels that collide.

Use [the large-text reflow guide](/blog/what-to-check-when-large-text-causes-layout-reflow/) to classify each failure.

Inspect transient states as well as the settled page: loading labels, empty states, validation errors, toast messages, download or progress status, and permission prompts. These strings may be longer than the default content and can expose fixed-height containers that ordinary labels do not. Confirm that the message remains available long enough to read and does not cover the action needed to continue.

## Check the on-screen keyboard

Open search and any relevant form. Verify the focused field, suggestions, clear action, error text, and submit control remain visible or can be reached while the keyboard is open.

Do not dismiss the keyboard manually before recording the actual obstruction.

Enter a long but realistic query and trigger an error or no-results state where safely possible. Verify that text selection, the clear control, and the back action remain usable without losing the typed value unexpectedly.

## Check orientation once

Rotate to the relevant alternate orientation. Confirm state remains intact, text reflows, dialogs fit, and controls remain reachable. Treat rotation as a separate boundary rather than repeatedly changing during the scale comparison.

## Distinguish recognition and layout

Larger text may improve legibility while revealing readability or navigation problems. Use [the legibility-versus-readability guide](/blog/legibility-and-readability-two-different-viewing-problems/) to avoid reversing a useful setting.

The [complete visual-comfort guide](/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/) connects scaling with zoom, environment, colour, focus, and motion.

## Test app and browser separately

Native app text scaling and a mobile browser's page behavior can differ. Record which context is tested and do not generalise one to the other.

Current Norva mobile and web support must be confirmed officially.

## Report a scaling barrier

Include device, operating system, app/browser version, exact setting, language, task, expected result, observed clipping or loss, keyboard/orientation context, and privacy-safe screenshots.

## Common mistakes and limitations

Avoid emulator-only conclusions, resetting text, checking labels without tasks, and treating truncation as acceptable when the full name has no reveal path.

This audit documents supported contexts; it does not guarantee identical platform scaling behavior.

## Frequently asked questions

### Is mobile text scaling the same as browser zoom?

No. System text settings, display scaling, and browser zoom can affect layouts differently.

### Should text be allowed to overlap rather than truncate?

Neither is a good automatic outcome. Reflow, wrapping, resizing, or alternate layout should preserve meaning and operation.

### Can testing use an emulator?

It can support development, but verify physical size, keyboard, gestures, system settings, and rendering on real relevant devices.

## Your next step

[Explore Norva's mobile features](https://norva.tv/#features)

## Sources

- [W3C: Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html)
- [W3C: Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
- [Norva Features](https://norva.tv/#features)
