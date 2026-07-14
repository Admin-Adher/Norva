---
content_id: "NVB-934"
title: "Run Your First Favorite Sync Check"
seo_title: "Run Your First Norva Favorite Sync Check"
meta_description: "Verify a Norva favorite across two supported screens with one account and profile, a known item, add-remove checks, timestamps, and privacy-safe evidence."
slug: "run-first-favorite-sync-check"
canonical_url: "https://norva.tv/blog/run-first-favorite-sync-check/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "favorite-sync-verification-guide"
topic_cluster: "Norva Onboarding"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I verify that a Norva favorite is consistent across supported screens?"
supporting_questions:
  - "How should I test both adding and removing a favorite?"
  - "Which account, profile, item, and filter checks prevent false results?"
audience:
  - "New multi-device Norva users"
  - "Household account administrators"
author: { name: "", profile_url: "" }
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
excerpt: "A reliable favorite check tests add and remove directions across two screens while keeping account, profile, item identity, and filters fixed."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/norva-onboarding-complete-journey/"
related_articles:
  - "/blog/norva-onboarding-complete-journey/"
  - "/blog/verify-first-catalog-sample/"
  - "/blog/evaluate-norva-cross-screen-continuity/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "bidirectional favorite state trace"
  summary: "A four-step trace captures initial state, add on screen A, observation on screen B, remove on screen B, and final observation on screen A."
  methodology: "The tester uses one known item and profile, resets filters, timestamps each action, and records icon state and list membership separately before any retry."
  asset_urls: []
---

# Run Your First Favorite Sync Check

> **In short:** Choose one recognizable item, confirm it is not already a favorite, and use the same Norva account and profile on two supported screens. Add it on screen A, inspect its icon and Favorites list on screen B, remove it on B, then verify the final state on A. Record timestamps and filters; do not use a private title in evidence shared externally.

Norva can keep favorites in the viewing context across supported devices, but an informal glance can produce false conclusions. A filter, different profile, similar title, or stale view may hide the real state. Begin with the [first catalog sample](/blog/verify-first-catalog-sample/) so item identity is already established.

## Define screens and identity

Label the two supported screens A and B. Record the broad surface, device category, network context, account shorthand, and profile shorthand. Confirm both screens display the same profile before changing anything.

Use a known item with an unambiguous identity. If multiple versions are grouped, record the grouping state and the work-level identity used by the interface.

## Establish a neutral starting state

Reset filters, open the Favorites area on both screens, and confirm whether the item is already present. Inspect both list membership and the item's favorite icon. If they disagree before the test, preserve that baseline rather than forcing a clean result.

Remove the item only if the test plan explicitly calls for establishing an unfavorited baseline, then verify that removal on both screens before beginning the measured steps.

## Add on screen A

Open the known item on A and activate the visible favorite control. Record the local time, resulting icon state, and whether the item appears in the local Favorites view. Do not press the control repeatedly; a second activation may reverse the first action.

Exit or navigate using the normal interface. Do not delete history, switch profiles, or reconnect the source during the trace.

## Inspect on screen B

Before refreshing or changing filters, record the existing view on B. Then use the normal supported navigation or refresh behavior and inspect both the item's icon and Favorites list membership. Record when the state becomes visible, but do not publish a universal synchronization-time claim from one household test.

Classify the observation as present, absent, conflicting, wrong item, or unknown. A matching icon with a hidden filtered list is different from an absent favorite.

## Remove on screen B

Activate the favorite control once on B to remove the item. Record the timestamp, icon state, and local list result. Return to A and inspect the same two signals under neutral filters.

The reverse direction matters because add and remove paths can expose different stale-state behavior. Do not stop after only a successful addition.

## Repeat only after preserving evidence

If a direction fails, confirm account, profile, item identity, source, grouping, filters, and network context. Capture a privacy-safe screenshot only if needed. Then repeat that direction once without altering several variables.

Use the broader [cross-screen continuity evaluation](/blog/evaluate-norva-cross-screen-continuity/) for repeated trials with progress and preferences. The [Norva onboarding journey](/blog/norva-onboarding-complete-journey/) shows how this one trace fits the first-week review.

## Original evidence: favorite-state trace

| Step | Screen | Action | Icon state | List membership | Time |
| --- | --- | --- | --- | --- | --- |
| Baseline | A and B | Observe |  |  |  |
| Add | A | Add once |  |  |  |
| Forward check | B | Observe |  |  |  |
| Remove | B | Remove once |  |  |  |
| Reverse check | A | Observe |  |  |  |

Attach the filter and grouping state to each observation. Keep credentials, full account identifiers, and private catalog details out of the record.

## Common favorite-test mistakes

- Comparing different household profiles.
- Selecting a similar title or another version.
- Checking only the icon or only the list.
- Leaving a source or availability filter active.
- Pressing the favorite control more than once.
- Claiming a fixed sync speed from one observation.

## Frequently asked questions

### Why test removal as well as addition?

It verifies the reverse state transition and helps expose a stale list or icon that one successful add would not reveal.

### What if the icon is active but the Favorites list is empty?

Record the conflict, reset relevant filters, confirm profile and item identity, and inspect again. Preserve both observations before attempting a change.

### Should grouped versions have separate favorites?

Do not assume a universal rule. Record the current grouping state and work or version identity, then compare behavior with current official guidance.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
