---
content_id: "NVB-427"
title: "Why a Target Device May Resume From an Older Position"
seo_title: "Why a Target Device Resumes From an Older Position"
meta_description: "Diagnose an older resume position by checking profile, item, episode, version, source connectivity, target freshness, and the last confirmed source state."
slug: "why-a-target-device-may-resume-from-an-older-position"
canonical_url: "https://norva.tv/blog/why-a-target-device-may-resume-from-an-older-position/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-guide"
topic_cluster: "Cross-Device Handoff"
search_intent: "stale handoff resume position diagnostics"
funnel_stage: "retention"
primary_question: "Why might a target device resume from an older playback position?"
supporting_questions:
  - "Which mismatch should I check first?"
  - "How do I preserve evidence before correcting the position?"
audience:
  - "Viewers seeing stale progress after handoff"
  - "People troubleshooting cross-device continuity"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Diagnose an older resume position by checking profile, item, episode, version, source connectivity, target freshness, and the last confirmed source state."
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
parent_pillar: "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
related_articles:
  - "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
  - "/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/"
  - "/blog/how-to-document-a-cross-device-handoff-failure/"
cta:
  label: "Review Norva's Continuity Features"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "stale-position differential"
  summary: "A diagnostic differential orders identity and connectivity checks before timeline correction and preserves the first observed source and target positions."
  methodology: "Readers record both positions, test profile, item, version, and connectivity one at a time, and classify the first confirmed mismatch without claiming an unobserved cause."
  asset_urls: []
---
# Why a Target Device May Resume From an Older Position

> **In short:** An older target position can come from a different profile, episode, or version; a source device that never preserved its latest state; a target that has not refreshed account state; or temporary connectivity. Record both positions before changing anything, then verify identity and account layers first. The visible symptom alone does not identify the cause.

Norva states that progress can follow the same account across supported devices. A stale-looking timeline is therefore a state mismatch to investigate, not proof that synchronisation is universally broken.

## Preserve the first evidence

Pause both screens if possible and record:

- source and target device roles;
- account and profile;
- full item or episode identity;
- selected version;
- source position;
- target position;
- whether each screen is online;
- the last successful action on the source.

Do not seek the target immediately. Once the timeline is changed, the original difference is harder to analyse.

## Check identity before timing

The most important question is whether both screens show the same media object. Confirm title and year for a film, or series, season, episode number, and title for episodic media. Then match the version or source label.

The [mid-episode handoff workflow](/blog/how-to-hand-off-mid-episode-without-opening-the-wrong-episode/) explains why an adjacent episode can display plausible progress and artwork.

**Resolution signal:** item and version identity match independently on both screens.

## Check profile context

Confirm the same intended profile is selected. Different household profiles can maintain different progress, history, favourites, and preferences. Do not switch profiles repeatedly while diagnosing; each change creates another state.

If the target opens a generic continuation area, return to profile selection or a stable library screen and verify the profile explicitly.

## Check the source's final state

Ask whether the source was paused at the recorded position, whether the app had time to show that state, and whether it remained connected. Do not invent a required delay. Instead, observe whether the source still displays the expected position after reopening the detail or playback screen.

If the source itself shows the older position, the issue began before target comparison. If the source shows the newer position and identity matches, continue to target freshness.

## Reopen the target through documented controls

Return to a stable target screen, then reopen the same item and version. Watch for a visible status or error message. W3C status-message guidance explains why state changes should be communicated, but the exact Norva interface must be observed.

Avoid repeated force-closing, data clearing, reinstalling, or rapid refresh actions before preserving evidence.

## Compare one condition at a time

If the discrepancy remains, try one controlled comparison:

- same profile and item after reauthentication;
- same version on another supported target;
- same target on a trusted network;
- another authorised item on the same device.

A comparison narrows conditions; it does not prove a universal cause. Use the [cross-device state model](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) to keep account, source, item, and presentation layers separate.

## Correct the position only after diagnosis

Once identity and profile match, decide which visible position is authoritative based on the actual session record. Seek deliberately on the target only if the viewer agrees. Then play a short section, pause, and verify whether a later reopen preserves the new position.

Do not clear history or alter another profile to repair one timeline.

## Original evidence: stale-position differential

| Check | Source | Target | Match? |
| --- | --- | --- | --- |
| Account/profile |  |  |  |
| Item/episode |  |  |  |
| Version/source label |  |  |  |
| Position before changes |  |  |  |
| Connectivity state |  |  |  |
| Position after one reopen |  |  |  |
| One-variable comparison |  |  |  |

Record the first mismatched row. If no row explains the symptom, preserve the sheet with a [support-ready handoff report](/blog/how-to-document-a-cross-device-handoff-failure/).

## Common mistakes and limitations

Avoid seeking before recording, comparing different variants, assuming the first continuation card is correct, changing profiles during the test, or declaring a timing threshold without evidence.

Connectivity, source availability, authentication, device lifecycle, and metadata can affect observed state. This diagnostic cannot guarantee the newest position is recoverable.

## Frequently asked questions

### Should I wait a fixed number of seconds before opening the target?

No universal delay is verified. Pause clearly, observe the source state, and use visible evidence rather than an invented timer.

### Is the newer position always correct?

Usually it represents later viewing, but confirm that it belongs to the intended profile, item, and version.

### Should I clear app data?

Not before documenting the issue. Data clearing can remove useful state and should follow verified support guidance.

## Your next step

[Review Norva's continuity features](https://norva.tv/#how-it-works)

## Sources

- [W3C: Understanding Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Support](https://norva.tv/support)

