---
content_id: "NVB-933"
title: "Run Your First Playback Progress Sync Check"
seo_title: "Run Your First Norva Progress Sync Check"
meta_description: "Verify Norva playback progress across two supported screens with one profile, a known item, recorded positions, controlled timing, and safe evidence."
slug: "run-first-progress-sync-check"
canonical_url: "https://norva.tv/blog/run-first-progress-sync-check/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "progress-sync-verification-guide"
topic_cluster: "Norva Onboarding"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I verify playback progress across supported Norva screens?"
supporting_questions:
  - "Which account, profile, item, and timing conditions must remain fixed?"
  - "How should I classify a delayed or incorrect resume position?"
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
excerpt: "A controlled two-screen progress test keeps account, profile, source, item, and network context explicit while comparing recorded positions."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/norva-onboarding-complete-journey/"
related_articles:
  - "/blog/norva-onboarding-complete-journey/"
  - "/blog/verify-first-playback-session/"
  - "/blog/evaluate-norva-cross-screen-continuity/"
cta:
  label: "Review Norva Features"
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
  type: "two-screen progress synchronization trace"
  summary: "A timestamped A-to-B-to-A trace compares the saved position, displayed resume point, actual resumed point, account, profile, and item identity."
  methodology: "The viewer creates a distinctive position on screen A, exits normally, checks screen B without altering the profile or item, then returns to screen A to isolate direction-specific behavior."
  asset_urls: []
---

# Run Your First Playback Progress Sync Check

> **In short:** Use the same Norva account, profile, authorized source, and known item on two supported screens. Create a distinctive playback position on screen A, exit normally, record the time, then inspect and resume on screen B. Repeat back to A. Keep displayed and actual positions separate, and avoid judging synchronization from an ambiguous one-minute difference.

Norva can keep viewing progress across supported devices under the same account, but a useful check still requires controlled identities and timing. Complete the [same-screen playback verification](/blog/verify-first-playback-session/) first; otherwise a local resume problem can be mistaken for cross-screen synchronization.

## Define the two screens

Label the screens A and B using broad categories such as web, mobile, or TV. Record the current Norva surface, device category, network context, and local time for each. Do not place device serial numbers or precise household locations in shareable evidence.

Confirm both screens use the same intended account and profile. A different profile should maintain its own viewing context and is not a valid comparison.

## Choose a distinctive position

Select a familiar item known to play on both screens. Avoid an opening scene, credits, or an episode boundary. Play long enough to reach a position that is easy to distinguish, then record the approximate elapsed time and a non-sensitive scene cue.

Do not use a complete title or screenshot if the evidence may be shared. A private item code and elapsed time are usually sufficient.

## Exit screen A cleanly

Pause briefly if appropriate, then leave playback using the interface. Record the exit time and any displayed progress. Do not force-close the app, disconnect the network, or edit the source during the baseline run unless that behavior is the explicit subject of a later test.

Allow only the normal transition needed to open screen B. If current official guidance specifies a wait or refresh step, record and follow it; otherwise do not invent a universal synchronization deadline.

## Inspect before resuming on screen B

Find the same item under the same profile. Record any progress bar, continue action, or displayed resume point before selecting it. Then resume and note the actual playback position. A visual bar estimate and the actual resumed time are separate observations.

Classify the result as matched within the test tolerance, stale, missing, ahead, wrong item, or unknown. Define the tolerance before testing based on how precisely the interfaces expose time.

## Run the reverse direction

On screen B, play to a new distinctive position, exit normally, and repeat the inspection on screen A. A-to-B success does not automatically prove B-to-A behavior under all conditions.

The broader [cross-screen continuity evaluation](/blog/evaluate-norva-cross-screen-continuity/) adds favorites, preferences, navigation effort, and repeated trials once this first trace is stable.

## Isolate a failed result

If the position differs, confirm account, profile, source item, version, and network status before repeating. Test the same direction once more without changing multiple variables. Record whether the issue is consistent or intermittent.

Do not delete history or reconnect the source before preserving evidence. Those actions remove the state needed for diagnosis.

## Original evidence: A-to-B-to-A trace

| Direction | Exit time | Saved or displayed position | Actual resume position | Classification |
| --- | --- | --- | --- | --- |
| Screen A to B |  |  |  | Match / Stale / Missing / Unknown |
| Screen B to A |  |  |  | Match / Stale / Missing / Unknown |

Above the table, record the account shorthand, profile shorthand, source shorthand, item version, both screen categories, networks, and the predeclared tolerance. Keep credentials and full identifiers out.

## Common sync-test mistakes

- Comparing different profiles or versions.
- Starting near credits or an episode boundary.
- Recording only the progress-bar appearance.
- Force-closing during the baseline exit.
- Changing network, item, and profile after a mismatch.
- Claiming a universal sync speed from one trial.

The [Norva onboarding journey](/blog/norva-onboarding-complete-journey/) helps combine this trace with favorites, preferences, privacy, and the first-week audit.

## Frequently asked questions

### Must both screens use the same network?

Not necessarily for supported account synchronization, but network context can affect the test. Record it and keep it stable for the first run before evaluating a network change separately.

### How exact should the resume position be?

Define a practical tolerance from the time precision visible in the interfaces. Record both displayed and actual positions; do not imply frame-perfect behavior without evidence and an official product commitment.

### What if screen B shows the right item but no position?

Classify item identity and progress as separate results. Reconfirm profile and version, preserve the state, and repeat once under the same conditions before consulting official support.

## Your next step

[Review Norva Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
