---
content_id: "NVB-337"
title: "Where Primary Actions Should Sit on a TV Detail Screen"
seo_title: "Place Primary Actions on a TV Detail Screen"
meta_description: "Place TV primary actions after essential identity in a stable region, label them precisely, order secondary actions clearly, and preserve D-pad routes."
slug: "place-primary-actions-tv"
canonical_url: "https://norva.tv/blog/place-primary-actions-tv/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "design guide"
topic_cluster: "TV Interface Ergonomics"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "Where should the primary action sit on a TV detail screen?"
supporting_questions:
  - "How should primary and secondary actions be ordered?"
  - "When is initial focus on the primary action safe?"
audience:
  - "TV interface designers"
  - "Norva teams reviewing film and series actions"
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
excerpt: "A stable action hierarchy that places the safest likely next step near essential identity while protecting variants, series details, and secondary controls."
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
  - "/blog/balance-tv-detail-panel/"
  - "/blog/choose-initial-tv-focus/"
  - "/blog/design-tv-confirmation-dialogs/"
cta:
  label: "Preview Norva's TV Detail Screen"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "TV primary-action placement map"
  summary: "A task map compares action location, label, initial focus, progress context, version safety, secondary sequence, disabled state, confirmation, and Back restoration."
  methodology: "Reviewers test film, series, resume, unavailable, multi-version, completed, and no-progress states using a remote, recording wrong activations and focus travel without asserting one universal coordinate."
  asset_urls: []
---

# Where Primary Actions Should Sit on a TV Detail Screen

> **In short:** Place the primary action immediately after the title and essential decision context in a stable action region. Keep it visually dominant but label the actual outcome—Play, Resume, View series details, or another verified action. Initial focus may land there only when activation is safe and predictable. Put variants and secondary actions nearby without competing equally.

The best location is not a universal coordinate. It is the position where identity, consequence, and remote path converge consistently across detail states.

## Establish action prerequisites

Before reaching the action, the viewer should know:

- exact title or episode;
- active profile when relevant;
- progress or completion context;
- selected version when alternatives matter;
- availability and required language or subtitles;
- whether the action opens playback or another detail layer.

Use [the balanced detail-panel model](/blog/balance-tv-detail-panel/) to keep this context stable without allowing a long synopsis to move the action.

## Label the current outcome

“Play” is wrong when the control opens a series detail page; “Continue” is wrong when the selected version or episode is unresolved. Use concise outcome-specific labels. W3C headings-and-labels guidance supports descriptive labels, while focus-order guidance supports meaningful sequence.

Do not promise a playback result that depends on unverified source or current state.

## Order secondary actions deliberately

Place Favorite, Details, Versions, Seasons, Rate, or other verified current actions after the primary action according to frequency and consequence. Do not give every action equal visual weight. Separate destructive actions and require a suitable confirmation pattern where risk justifies it.

Use [clear TV confirmation dialogs](/blog/design-tv-confirmation-dialogs/) for consequential actions, never as decoration for harmless navigation.

## Decide initial focus by state

Initial focus on the primary action can be efficient when it is safe, visible, and the likely next step. It is not safe when the action is destructive, unavailable, ambiguous, or may start an unexpected version.

Apply [the initial-focus decision guide](/blog/choose-initial-tv-focus/) to fresh detail, resume, completed, multi-version, error, and returning states. When Back returns from episodes or variants, restore the originating control rather than resetting to the primary action.

## Keep position stable across content

Reserve title, metadata, and action regions so long text, missing badges, or extra variants do not shift the row. If actions wrap, define the spatial graph for every row. Do not allow the first action to move below the fold because a synopsis grew.

Android TV quality guidance reinforces remote-first navigation. Exact Norva action sets and labels require verification in the current TV release.

## Test the decision path

For each content state, ask a reviewer to identify the action and expected result before pressing Select. Then test Left, Right, Down to secondary content, Back from nested layers, unavailable state, and rapid repeated Select.

Record wrong expectations, accidental activation, focus loss, and position changes. A short path is not successful when the label or version is ambiguous.

## Original evidence: action placement map

Create one row per detail state and columns for prerequisites, primary label, position, initial focus, selected version, secondary sequence, Back target, and observed result. Test remotely with long and sparse metadata.

The map supports a design-system placement rule. It does not establish one action or coordinate for every media type.

Recheck the rule when playback progress, entitlement, or variant availability changes. The region should remain stable even when its most appropriate primary label changes.

## Common mistakes and limitations

- Putting Play before exact identity.
- Using one label for playback and navigation.
- Focusing an ambiguous or destructive action initially.
- Letting synopsis length move buttons.
- Giving every secondary action equal emphasis.
- Resetting focus after returning from variants.

## Frequently asked questions

### Should Play always be the first button?

No. The first action should match the verified detail state and safest likely next task.

### Can a series card use “View details” as primary?

Yes, when the next step is to choose seasons, episodes, or variants rather than resume an assumed item.

### Where should unavailable actions go?

Keep the layout understandable, communicate why the action cannot run, and provide the nearest valid alternative without a dead-end focus trap.

## Your next step

[Preview Norva's TV Detail Screen](https://norva.tv/#product-preview)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [W3C: Understanding Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html)
- [Norva Features](https://norva.tv/#features)
