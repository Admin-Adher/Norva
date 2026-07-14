---
content_id: "NVB-360"
title: "A D-Pad Navigation Accessibility Checklist"
seo_title: "D-Pad Navigation Accessibility Checklist"
meta_description: "Audit D-pad accessibility for clear visible focus, logical routes, accurate semantics, disabled states, overlays, Back behavior, motion, and recovery."
slug: "dpad-accessibility-checklist"
canonical_url: "https://norva.tv/blog/dpad-accessibility-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "accessibility checklist"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should a D-pad navigation accessibility checklist include?"
supporting_questions:
  - "Which focus, semantics, and route checks protect remote users?"
  - "How should overlays, dynamic states, and disabled controls be validated?"
audience:
  - "TV accessibility, design, engineering, and QA teams"
  - "Norva teams reviewing D-pad releases"
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
estimated_reading_minutes: 8
excerpt: "A release checklist that combines visible focus, semantic state, predictable spatial routes, layered interactions, dynamic recovery, and viewing-distance evidence."
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
  - "/blog/communicate-disabled-tv-controls/"
  - "/blog/test-focus-with-overlays/"
  - "/blog/build-dpad-test-matrix/"
cta:
  label: "Preview Norva's TV Navigation"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html"
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "D-pad accessibility release scorecard"
  summary: "A scorecard maps visible focus, semantic identity, spatial routes, state changes, overlays, disabled controls, motion, and recovery to pass criteria and evidence."
  methodology: "A reviewer operates representative journeys only with directional, Select, and Back input from viewing distance, inspects exposed semantics, mutates content, and attaches route and visual evidence to failures."
  asset_urls: []
---

# A D-Pad Navigation Accessibility Checklist

> **In short:** Verify that one focus cue is always visible and unobscured, movement is logical and reversible, every focused control exposes an accurate name, role, and state, disabled targets follow a consistent policy, overlays contain and restore focus, Back preserves context, and dynamic updates never strand the viewer. Test with a real remote from viewing distance.

D-pad accessibility is not satisfied by making every element focusable. Too many targets, misleading semantics, or missing edge routes can make a screen technically reachable and practically unusable.

## Visible focus

- Exactly one actionable target appears focused.
- The cue remains distinguishable over bright, dark, and detailed artwork.
- Focus does not rely on color, scale, or motion alone.
- Sticky headers, dialogs, clipping, and safe-area edges do not obscure it.
- Loading shapes and decorative elements never receive focus.
- Focus remains visible after content changes or an item disappears.

Use W3C's guidance on [focus visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) and [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) as baselines, then add TV viewing-distance and spatial tests.

## Logical directional routes

- Up, Down, Left, and Right lead to visually and semantically plausible destinations.
- Every cross-region entry has a clear reverse route.
- First and last edges stop, reveal, wrap, or transition according to a documented policy.
- Incomplete rows and different card widths have deterministic fallbacks.
- Page and row scrolling do not happen for the same input.
- Held keys stop promptly and do not overshoot.

Record these edges in the [direction-by-direction test matrix](/blog/build-dpad-test-matrix/).

## Accurate names, roles, and states

- Every control has a concise accessible name matching its visible purpose.
- Buttons, links, tabs, options, and toggles expose appropriate roles.
- Selected, expanded, checked, unavailable, and disabled states remain accurate.
- Visible focus is distinct from persistent selection.
- Icon-only controls have understandable names.
- Dynamic labels update when the action changes, such as Play versus Resume, only when verified state supports it.

W3C's [Name, Role, Value explanation](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html) provides the core standard reference.

## Predictable activation and disabled controls

- Select activates the visibly focused target once.
- Directional movement does not silently commit consequential changes.
- Disabled custom controls never fire.
- The focusability of disabled items follows a consistent discoverability policy.
- A reason and valid alternative are available when needed.
- Initial focus never starts on an unavailable or destructive action.

Apply the decision matrix in [communicating disabled TV controls](/blog/communicate-disabled-tv-controls/).

## Overlays, dialogs, and keyboards

- Opening captures the semantic origin before layout changes.
- Initial focus is safe, visible, and appropriate to the layer.
- Modal focus cannot reach the background.
- Every layer has a completion and cancellation route.
- Back closes only the top layer and never confirms destruction.
- Closing restores the opener or a documented nearby fallback.
- Nested overlays preserve separate origins.

Run the lifecycle cases in [testing D-pad focus with overlays](/blog/test-focus-with-overlays/).

## Dynamic content and status

- Background loads preserve valid current focus.
- New content does not steal focus.
- Removed targets move to a semantic sibling or region anchor.
- Loading, empty, and error are distinct states with valid routes.
- Status changes are available without forcing focus movement.
- Late or superseded responses cannot trigger stale focus requests.

Test delayed, failed, empty, and out-of-order data, not only a fast successful response.

## Back and restoration

- Back closes temporary layers before leaving the page.
- Detail return restores item, row, filters, query, and scroll when valid.
- A removed origin uses a nearby task-level fallback.
- App Home is not used as a generic recovery target.
- Repeated Back presses do not skip unresolved visual layers.

## Readability and motion

- Focused labels remain readable from intended distance.
- Text is not clipped by card scaling or localized length.
- Focus animation does not move neighbouring targets.
- Reduced-motion preferences receive an appropriate alternative.
- Fast navigation does not queue distracting motion.

## Produce a release scorecard

For every check, record pass, fail, or not applicable; device and build; route case; screenshot or recording; semantic inspection; severity; owner; and retest. Block releases according to the team's policy when viewers cannot locate focus, escape a layer, avoid unintended activation, or complete a core task.

Combine this checklist with the broader [remote and D-pad QA guide](/blog/remote-dpad-navigation-qa/) rather than replacing journey testing.

## Common mistakes and limitations

- Equating focusability with accessibility.
- Auditing semantics without visible remote behavior.
- Testing only ideal artwork and content.
- Ignoring disabled and disappearing targets.
- Verifying a modal without Back and restoration.
- Treating focus and selected state as the same cue.
- Signing off without viewing-distance evidence.

## Frequently asked questions

### Does WCAG define every TV D-pad route?

No. WCAG supplies essential accessibility criteria, while product and platform spatial-navigation contracts need additional task-specific testing.

### Must disabled controls remain focusable?

Not always. Decide consistently from discoverability, efficiency, component pattern, explanation, and alternative action.

### Can automated tests complete the checklist?

They can protect deterministic routes and semantics, but real remote timing, viewing-distance focus, display behavior, and perceived motion need human review.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [W3C: Understanding Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)
- [W3C: Understanding Name, Role, Value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html)
- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
