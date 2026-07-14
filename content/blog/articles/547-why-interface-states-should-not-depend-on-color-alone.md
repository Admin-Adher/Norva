---
content_id: "NVB-547"
title: "Why Interface States Should Not Depend on Color Alone"
seo_title: "Why Interface States Need More Than Color"
meta_description: "Review focused, selected, active, unavailable, error, and progress states using labels, icons, shape, contrast, and programmatic meaning beyond color."
slug: "why-interface-states-should-not-depend-on-color-alone"
canonical_url: "https://norva.tv/blog/why-interface-states-should-not-depend-on-color-alone/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "accessibility-explainer"
topic_cluster: "Visual Comfort & Accessibility"
search_intent: "color independent interface states"
funnel_stage: "consideration"
primary_question: "Why should media interface states use more than color alone?"
supporting_questions:
  - "Which focused, selected, active, unavailable, error, and progress states need redundant cues?"
  - "How can color-independent meaning be tested across input methods and viewing conditions?"
audience:
  - "Viewers comparing media interface states"
  - "Design and product teams reviewing accessible state communication"
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
excerpt: "A state-by-state audit for communicating focus, selection, availability, errors, and progress without relying on color alone."
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
  - "/blog/how-to-check-focus-visibility-on-a-shared-screen/"
  - "/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/"
  - "/blog/legibility-and-readability-two-different-viewing-problems/"
cta:
  label: "Explore Norva's Interface Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "interface state cue inventory"
  summary: "A state inventory records the color cue, visible non-color cue, programmatic meaning, contrast boundary, input method, viewing context, and identification result for every interactive state."
  methodology: "The reviewer captures paired default and changed states, names the meaning without using color words, tests mouse, keyboard, remote, and touch where applicable, and records ambiguous or missing cues."
  asset_urls: []
---
# Why Interface States Should Not Depend on Color Alone

> **In short:** Color can reinforce an interface state, but it should not be the only way to communicate focus, selection, availability, errors, progress, or status. Pair color with visible text, an icon, shape, border, pattern, position, or another clear change, and expose the state programmatically where applicable. Test whether a viewer can name the state without referring to a color.

A media interface contains many adjacent states: a focused card is not necessarily selected, a selected track is not the same as the currently playing item, and an unavailable action differs from an inactive filter. If all of those distinctions depend on hue, meaning can disappear under glare, low saturation, display variation, or individual color perception.

## Inventory every state pair

List the default and changed versions of:

- focused and unfocused controls;
- selected and unselected filters, tracks, or tabs;
- active and inactive navigation;
- available and unavailable actions;
- error, warning, success, and informational messages;
- watched, unwatched, and in-progress indicators where present;
- loading, complete, and failed progress states.

Treat each pair as a separate communication problem.

## Ask what changes besides color

Useful redundant cues can include a visible check mark, explicit state word, underlining, border thickness, filled versus outlined shape, icon, progress label, or a stable positional marker. The cue must fit the meaning: adding an arbitrary symbol can create a second ambiguity.

For text links and other controls, consult the applicable accessibility guidance rather than assuming any single styling technique always passes.

## Distinguish focus from selection

Focus shows where the next keyboard or remote action will apply. Selection records a choice or current state. A card can be selected while focus moves elsewhere, so the two indicators should remain distinguishable.

Run [the shared-screen focus check](/blog/how-to-check-focus-visibility-on-a-shared-screen/) to test the focus cue at normal distance, not only on a close screenshot.

## Original evidence: state cue inventory

| Component/state | Meaning | Color cue | Non-color cue | Programmatic state | Input/context | Identified correctly? |
|---|---|---|---|---|---|---|
| Filter selected | Choice applied | Description | Label/check/shape | Observed value | Keyboard/remote/touch | Yes/no |
| Action unavailable | Cannot activate | Description | Text/icon/shape | Observed value | Context | Yes/no |
| Error | Correction needed | Description | Message/icon | Observed value | Context | Yes/no |

To reduce bias, ask the viewer to explain the state without using color names. Record uncertainty as a result rather than prompting the answer.

## Check contrast and boundaries too

A non-color cue still needs to be perceptible. A faint outline or tiny icon may technically differ while disappearing at sofa distance or against a busy image. Review component and graphical boundaries under the applicable non-text contrast guidance.

Test bright and dark backgrounds, focused and selected combinations, and ordinary display settings. Use [the complete visual-comfort guide](/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/) to separate color, environment, focus, scaling, and motion variables.

## Test with real input methods

Move through the interface with keyboard and remote where those contexts are supported. Use touch and pointer states separately because hover is not available everywhere. Confirm that a pressed, toggled, or chosen control keeps its meaning after focus moves away.

For errors, trigger a safe validation case. Check whether the message names the affected field or action and explains what can be corrected. A red border alone does not communicate the required next step.

## Include programmatic meaning

Visible redundancy and programmatic state serve related but different needs. Inspect accessible names, roles, values, selected states, expanded states, and disabled states with appropriate accessibility tools. Do not infer correct semantics from appearance.

Likewise, a correct programmatic state does not excuse a visually ambiguous control for people using the screen directly.

## Do not rely on a filter simulation alone

Color-vision simulations can support design exploration, but they do not represent every person, display, room, or task. Combine them with the state inventory, contrast checks, input testing, and feedback from relevant users. Avoid medical assumptions about why someone misses a state.

[The legibility-versus-readability guide](/blog/legibility-and-readability-two-different-viewing-problems/) helps distinguish an imperceptible cue from a confusing state model.

## Report a state failure

Include component, default state, changed state, intended meaning, all visible cues, programmatic observation, input method, distance or viewport, background, and privacy-safe evidence. State "selection is shown only by a hue change" rather than "the color is bad."

Current Norva state behavior must be checked in the relevant supported product context and against official product information.

## Frequently asked questions

### Does this mean color should be removed?

No. Color can be a valuable reinforcing cue; it should not be the sole carrier of essential state meaning.

### Is an icon always enough as the second cue?

No. The icon must be perceivable and understandable in context, and a visible label may still be clearer.

### Are focus and selection the same state?

No. Focus identifies the current interaction target, while selection communicates a chosen or active value.

## Your next step

[Explore Norva's interface features](https://norva.tv/#features)

## Sources

- [W3C: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- [W3C: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- [Norva Features](https://norva.tv/#features)
