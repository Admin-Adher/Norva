---
content_id: "NVB-192"
title: "How to Spot a Filter You Forgot Was Active"
seo_title: "Find a Forgotten Active Media Filter"
meta_description: "Find forgotten media filters by auditing visible and hidden state, comparing counts with a clean baseline, and tracing inherited, persistent, and profile scope."
slug: "find-hidden-active-filters"
canonical_url: "https://norva.tv/blog/find-hidden-active-filters/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Filter Strategies"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can a forgotten active media filter be found?"
supporting_questions:
  - "Where can active filter state remain hidden?"
  - "How can a restricted result count be compared with a clean baseline?"
audience:
  - "People troubleshooting unexpectedly narrow media results"
  - "Norva users checking persistent or profile-specific filter state"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A seven-surface state inventory reveals active conditions that are collapsed, inherited, persistent, profile-specific, or obscured by device layout."
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
parent_pillar: "/blog/media-filter-strategy-guide/"
related_articles:
  - "/blog/reset-filters-preserve-context/"
  - "/blog/diagnose-empty-filter-results/"
  - "/blog/should-filters-persist/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://www.w3.org/WAI/WCAG21/Understanding/focus-visible"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "seven-surface filter-state inventory"
  summary: "An inventory checks query, category, visible controls, collapsed controls, scope, persistence, and transient loading state in a fixed order."
  methodology: "Readers capture the anomalous count, inspect seven state surfaces, compare another profile or device only as a controlled test, then reset from a saved context passport."
  asset_urls: []
---

# How to Spot a Filter You Forgot Was Active

> **In short:** Compare the current result count with a known clean baseline, then inspect seven surfaces in order: search text, category, visible chips and toggles, collapsed panels, source and profile scope, persisted session state, and refresh or loading state. Record each value before clearing it. If the count changes after one action, that transition identifies the forgotten condition.

A forgotten filter often feels like missing content: a known title disappears, a category looks unusually small, or another device shows more results. The key is to inventory state rather than repeatedly pressing reset.

## Capture the anomaly

Record:

- the page and category;
- current result count;
- expected approximate baseline;
- one known record expected to appear;
- active profile and device;
- source scope and last refresh;
- the action immediately before the problem.

This keeps the hidden-filter diagnosis separate from source availability or metadata issues.

## Run the seven-surface inventory

| Surface | What to inspect | Recorded state | Count after clearing |
|---|---|---|---:|
| 1. Query | Search text, voice input, retained term |  |  |
| 2. Category | Current tab, collection, route |  |  |
| 3. Visible controls | Chips, toggles, ranges, selected values |  |  |
| 4. Collapsed controls | Drawer, overflow, off-screen row |  |  |
| 5. Scope | Source, profile, favorites, availability |  |  |
| 6. Persistence | Session, device, saved recipe |  |  |
| 7. Transient state | Loading, refresh, stale count |  |  |

Clear one surface at a time and observe the count. The first meaningful expansion identifies the condition or narrows the investigation.

## Check search and category first

Search text can remain active even when the field is scrolled away, covered by an on-screen keyboard, or represented only by a small clear icon. Category state may be inherited from a previous route rather than shown as a filter chip.

Return to the top, focus the search control, and verify the exact string. Then inspect the page heading, selected category tab, URL route when available, and any breadcrumb.

## Inspect visible and collapsed controls

Read every selected value, including apparently neutral labels. Open filter drawers, overflow menus, advanced sections, and horizontal rows that may extend beyond the viewport.

Look for:

- year ranges with only one boundary set;
- “hide unavailable” or “favorites only” toggles;
- audio or subtitle values;
- exclusion modes;
- an active chip beyond the visible row;
- a reset badge indicating non-default state.

W3C focus-visible guidance explains why a perceivable focus indicator matters for keyboard operation. On TV, trace focus through the whole control row; an off-screen focus stop can reveal a control that is otherwise overlooked.

## Verify scope and persistence

Confirm profile, connected-source scope, grouped-version state, and current catalogue. Then ask whether filters persist across pages, sessions, or devices.

Compare another profile or supported device only as a controlled test. A difference may reveal profile-specific persistence, but it may also reflect sync timing or layout. [The filter-persistence decision guide](/blog/should-filters-persist/) explains which states are reasonable to retain.

## Distinguish state from loading

A refresh can temporarily reduce counts, and a stale count can survive after controls change. Wait for a clear completion state, then recheck known controls. W3C notification guidance recommends communicating result status and resolution; a useful interface should say when a refresh or reset completes.

If the title remains absent at a verified clean baseline, the problem is no longer “a forgotten filter.” Check source availability, metadata, identity matching, and grouping.

## Reset only after recording context

Use [the context-preserving reset passport](/blog/reset-filters-preserve-context/) to save the task and must-haves. Reset all state, verify the baseline count and known record, then rebuild required conditions one at a time.

When one transition unexpectedly creates an empty set, use [the empty-result rollback ladder](/blog/diagnose-empty-filter-results/).

Norva may sync preferences and organise compatible sources a user is authorised to access across supported devices, but current results depend on source state, metadata, profile, and the specific interface state. Capture those details when contacting support.

## Common mistakes and limitations

- Clearing several controls at once.
- Ignoring search text because the field is off-screen.
- Assuming a selected category is a neutral baseline.
- Forgetting profile and source scope.
- Comparing devices during an incomplete refresh.
- Treating an absent title as proof of a hidden filter.

The inventory reveals state transitions; it cannot prove source-side availability without separate validation.

## Frequently asked questions

### Why does reset not restore the expected count?

The category, query, profile, source scope, or persistent preferences may sit outside the reset's scope. Audit all seven surfaces.

### Can filters persist on only one device?

They can depending on product design and sync timing. Treat device comparison as evidence, then verify the documented behavior.

### What if the count changes but the known title is still missing?

You found one restriction, but availability, metadata, grouping, or another condition may still explain that specific title.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [W3C: Understanding Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible)
- [Norva Support](https://norva.tv/support)
