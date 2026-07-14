---
content_id: "NVB-353"
title: "Back, Home, and Exit: Keep Remote Actions Distinct"
seo_title: "Keep TV Back, Home, and Exit Actions Distinct"
meta_description: "Keep Back, Home, and Exit distinct on TV: Back closes the current layer or restores context, Home respects the platform, and Exit remains explicit."
slug: "back-home-and-exit-behavior"
canonical_url: "https://norva.tv/blog/back-home-and-exit-behavior/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "navigation behavior guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should Back, Home, and Exit differ in a TV interface?"
supporting_questions:
  - "Which temporary layers should Back close before page navigation?"
  - "How should an app respect platform-owned Home and explicit Exit behavior?"
audience:
  - "TV product designers and engineers"
  - "Norva teams defining remote action hierarchy"
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
excerpt: "A layered remote-action contract that keeps cancellation, page return, platform navigation, and explicit session exit from collapsing into one button."
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
  - "/blog/preserve-focus-after-back/"
  - "/blog/navigate-tv-dialog-with-remote/"
  - "/blog/design-tv-confirmation-dialogs/"
cta:
  label: "Preview Norva's TV Navigation"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/guide/navigation/principles"
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "remote-action hierarchy matrix"
  summary: "A hierarchy matrix maps Back, platform Home, and explicit Exit across keyboard, dialog, picker, detail, playback controls, browse page, unsaved work, and root states."
  methodology: "Reviewers invoke each available action from every layer, record the closed layer or destination, retained state, focus restoration, system handoff, and any confirmation, then repeat with rapid presses."
  asset_urls: []
---

# Back, Home, and Exit: Keep Remote Actions Distinct

> **In short:** Back should undo the current navigation layer: close a keyboard, menu, picker, or dialog; leave a detail level; then return to the prior page state. Home belongs to the platform's global navigation model and should not be imitated by an in-app Back action. Exit, when offered, must be explicit and should not replace ordinary Back behavior.

When these actions collapse into “go somewhere else,” viewers lose context. The most damaging symptom is pressing Back inside a variant or episode layer and landing on the app's Home page.

## Model Back as a layer stack

Write the current hierarchy from top to bottom:

1. temporary input surface, such as an on-screen keyboard;
2. dropdown, picker, or dialog;
3. nested detail, variant, season, or episode layer;
4. full detail screen;
5. originating browse or search state;
6. root destination defined by the platform and product.

One Back press should normally remove only the top applicable layer. The [TV dialog navigation guide](/blog/navigate-tv-dialog-with-remote/) covers cancellation and opener restoration inside overlays.

## Preserve the origin on every return

Back is not complete when the correct screen appears but focus returns to the first card. Preserve query, filters, selected tab, row position, scroll, and semantic item identity where they remain valid.

Use the origin-token approach in [preserving focus after Back](/blog/preserve-focus-after-back/). If the exact item disappeared, restore a nearby task-level fallback rather than routing to Home.

## Respect the platform's Home action

Home is generally a system-level concept. An application should follow the target platform's current navigation requirements and avoid intercepting or duplicating platform-owned behavior without a verified reason. Consult the [Android navigation principles](https://developer.android.com/guide/navigation/principles) and TV quality guidance for the supported client.

If the app also has a destination called Home, label and route it as normal in-app navigation. Do not make the physical Back key silently behave like that menu item.

## Treat Exit as a separate, explicit choice

Many viewers do not need an in-app Exit command; platform navigation can move away from the application. If an explicit Exit is part of the verified product, label it clearly and place it away from frequent actions. Define whether it ends playback, closes a session, or only leaves the current surface.

Do not use “Exit” as vague copy for closing a dialog or returning from details. Those are Cancel, Close, or Back actions depending on the component.

## Confirm only meaningful consequences

Ordinary Back should remain fast. Add confirmation only when leaving would discard significant unsaved input or trigger another genuine consequence. In that case, name the consequence and begin on the safe action according to the [confirmation-dialog guide](/blog/design-tv-confirmation-dialogs/).

Do not ask “Are you sure?” every time someone leaves playback or a browse page. Excess confirmation makes the remote feel slow and trains viewers to approve warnings automatically.

## Define root behavior carefully

At the app's root, Back behavior depends on the platform and verified product contract. It may hand control to the system, expose an explicit choice, or follow another documented pattern. Do not invent an app-specific override from web navigation assumptions.

Whatever the contract, repeated Back presses must not race through several layers before focus and visual state update. Process transitions serially and ignore stale layer references.

## Build an action hierarchy test

For each screen state, record current layer stack, Back result, restored focus, retained context, Home result according to the platform, and explicit Exit result when present. Include keyboard open, filter popup, confirmation, variant picker, season list, detail, playback controls, root, error, and loading.

Test one press at a time, then rapid repeated presses. A recording should show the visual layer closing before the next action is accepted.

## Common mistakes and limitations

- Sending Back from a picker directly to app Home.
- Treating browser history as the complete layer model.
- Resetting filters and focus on return.
- Intercepting a platform-owned Home action casually.
- Labeling ordinary cancellation as Exit.
- Confirming every harmless Back action.
- Processing repeated Back presses against stale layers.

## Frequently asked questions

### Should Back ever open the app's Home page?

Only if Home is genuinely the documented previous or root destination after all current layers are resolved. It should not skip a valid intermediate context.

### Is an Exit button required?

Not universally. Follow platform expectations and the verified product contract. If present, make its consequence explicit.

### What should Back do from a variant list?

Close the variant layer and restore the relevant detail-screen target. A later Back can return to the originating browse item.

## Your next step

[Preview Norva's TV Navigation](https://norva.tv/#product-preview)

## Sources

- [Android Navigation Principles](https://developer.android.com/guide/navigation/principles)
- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [WAI-ARIA APG: Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [Norva Features](https://norva.tv/#features)
