---
content_id: "NVB-359"
title: "How to Report a Remote Navigation Bug Clearly"
seo_title: "Report a TV Remote Navigation Bug Clearly"
meta_description: "Report remote navigation bugs with device and build, exact state, focused start target, one-key steps, expected and actual results, evidence, and impact."
slug: "report-remote-navigation-bug"
canonical_url: "https://norva.tv/blog/report-remote-navigation-bug/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "QA reporting guide"
topic_cluster: "Remote & D-pad Navigation"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should a remote navigation bug be reported clearly?"
supporting_questions:
  - "Which state and input details make focus bugs reproducible?"
  - "How should evidence, severity, and privacy be handled?"
audience:
  - "TV testers, support teams, and engineers"
  - "Norva teams triaging remote navigation defects"
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
excerpt: "A reproducible defect template for remote input, focus state, routes, evidence, impact, privacy, and regression links."
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
  - "/blog/build-dpad-test-matrix/"
  - "/blog/diagnose-tv-focus-trap/"
  - "/blog/prevent-key-repeat-overshoot/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://developer.android.com/docs/quality-guidelines/tv-app-quality"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "remote-navigation defect template"
  summary: "A structured template captures environment, preconditions, semantic focus identity, minimal input sequence, expected route, actual route, reproducibility, evidence, impact, privacy review, and matrix case."
  methodology: "Reporters reduce a failure to the shortest one-key or layer transition, replay it from a clean state, collect a focus recording and identifiers, then validate the report with a second reviewer."
  asset_urls: []
---

# How to Report a Remote Navigation Bug Clearly

> **In short:** Name the device, client and build; describe the exact page, data, and overlay state; identify the visibly focused starting target; list one remote input per step; and separate expected from actual focus. Add reproducibility, impact, and a short privacy-safe recording. “The arrows freeze” is not enough to replay the defect.

Remote navigation bugs are state bugs. The same Right press can behave differently after loading, filtering, opening a dialog, returning from details, or holding a key. A useful report preserves that state.

## Write a precise summary

Use a format such as:

`[TV][Movies filters] Right from Audio filter has no visible destination after applying French`

Include surface, region, direction, start target, and relevant state. Avoid emotional labels or a proposed root cause in the title unless evidence proves it.

## Record the environment

Capture:

- device model or emulator profile;
- operating system or TV platform version;
- application or web client build;
- remote type and connection when relevant;
- account or content fixture stated without personal data;
- screen size or layout mode if geometry changes;
- network condition for async-only failures.

Do not include passwords, session tokens, private account identifiers, or unredacted personal media names in public or broadly shared evidence.

## Establish exact preconditions

State how to reach the screen and what must already be true: selected page, active filters, row position, compact header, loaded or loading results, open overlay, focused item, and scroll. A screenshot before the failing input is often more useful than one after focus disappears.

If the issue occurs after a data update, note which request completed and whether the focused target moved or was removed.

## Reduce the input sequence

Replay from a clean entry and remove unnecessary steps until the smallest route remains. Write one action per line:

1. Open Movies.
2. Focus Audio.
3. Select French.
4. Wait for results to finish updating.
5. Press Right once.

For held keys, record press, duration or repeat observation, release, and any movement after release. Reference the approach in [preventing key-repeat overshoot](/blog/prevent-key-repeat-overshoot/).

## Separate expected and actual outcomes

Expected should name a semantic target or documented edge, not “it should work.” Actual should state visible focus, target identifier when available, scroll, layer, and activation result.

Example:

- **Expected:** Focus enters the detail-panel primary action, or stays on Audio if that edge is defined to stop.
- **Actual:** No focus cue is visible; Select still opens the Audio menu.

That actual result suggests invisible focus differs from lost input, without claiming a root cause.

## Attach evidence that shows the cue

A short landscape recording should begin before the final setup step, show the remote input if possible, and continue briefly after failure. Add a focus debug overlay, semantic target log, or event trace when the build supports it.

Redact notifications, account names, email addresses, source labels, and other private content. Keep raw diagnostic logs in the approved internal channel.

## Report impact and reproducibility

State whether the task is blocked, a valid workaround exists, activation targets the wrong action, or the problem is visual only. Report attempts, devices, and frequency rather than writing “random.”

Unintended destructive activation, no escape route, invisible focus, and deterministic task blockage generally deserve higher urgency than a minor but recoverable extra key press. The team's severity policy remains the final authority.

## Link the route contract

Reference the case in the [direction-by-direction D-pad matrix](/blog/build-dpad-test-matrix/) and the intended behavior specification. If no expected route exists, assign design clarification rather than guessing.

For traps, include the worksheet fields from [diagnosing a TV focus trap](/blog/diagnose-tv-focus-trap/). Add the final regression case to the [complete remote QA guide](/blog/remote-dpad-navigation-qa/).

## Use a copyable report template

Include Summary, Environment, Preconditions, Minimal Steps, Expected, Actual, Reproducibility, Impact, Workaround, Evidence, Privacy Review, and Related Matrix Case. Close resolved reports with root cause, fix build, and exact regression coverage.

## Common mistakes and limitations

- Saying only that focus froze.
- Omitting the starting focused target.
- Mixing expected behavior into actual results.
- Attaching a recording that starts after failure.
- Guessing a root cause from symptoms.
- Sharing private identifiers or session data.
- Closing without a regression route.

## Frequently asked questions

### Is a video required?

Not always, but it is valuable for focus visibility, timing, scrolling, and key-repeat failures. Written steps and semantic target identities remain essential.

### What if the expected destination is unclear?

Report the ambiguity and request a route decision. Do not encode accidental current behavior as the contract.

### How should intermittent bugs be described?

Give attempts, successes, environment differences, timing conditions, and the shortest known route. Avoid the unsupported label “random.”

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Android TV App Quality Guidelines](https://developer.android.com/docs/quality-guidelines/tv-app-quality)
- [W3C: Understanding Focus Order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [Norva Support](https://norva.tv/support)
