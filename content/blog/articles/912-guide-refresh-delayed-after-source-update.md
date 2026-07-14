---
content_id: "NVB-912"
title: "Guide Refresh Delayed After a Source Update? Track the Sequence"
seo_title: "Guide Refresh Delayed? Track the Sequence"
meta_description: "Diagnose delayed guide refresh after source changes by recording source confirmation, guide states, channel samples, clock and zone, devices, and timestamps."
slug: "guide-refresh-delayed-after-source-update"
canonical_url: "https://norva.tv/blog/guide-refresh-delayed-after-source-update/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "guide-refresh-timeline"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose delayed guide refresh after source changes?"
supporting_questions:
  - "Which source confirmation, guide request, visible state, channel sample, clock, zone, device, and timestamp evidence belongs in the sequence?"
  - "How can elapsed time be reported without inventing a refresh promise?"
audience:
  - "Norva users awaiting guide schedule changes"
  - "Household source administrators"
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
estimated_reading_minutes: 8
excerpt: "A delayed-guide record links source edit and confirmation times to visible Norva guide states, sampled channels, time context, device versions, and user actions."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/now-next-information-stale/"
  - "/blog/guide-works-on-one-device-only/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Review Refresh Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.iana.org/time-zones"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source-to-guide refresh timeline"
  summary: "A timeline records source edit submission and confirmation, affected channel identities, old and new listing cues, guide request and visible states, device clock and zone, account and profile, filters, devices and application versions, and first appearance of each change."
  methodology: "The user confirms the source update, freezes guide context, observes a minimal sample without repeated requests, compares another supported device, uses only published timing guidance, and records retries as separate sequences."
  asset_urls: []
---

# Guide Refresh Delayed After a Source Update? Track the Sequence

> **In short:** Record when the source edit was submitted, when the provider first confirmed it, each affected channel and listing, any Norva guide request and visible state, device clock and time zone, filters, device, application version, and when each change appeared. Keep context stable, compare another supported device, and avoid repeated refreshes. Use only current official timing guidance; otherwise report elapsed observations without a universal deadline.

A delayed guide change is a relationship between source confirmation and later guide observations. The source-edit time alone is not enough, and the interface does not reveal an internal refresh process.

Keep the unchanged control sample visible throughout.

## Define the source change

Record whether the provider changed a channel identity, program title, description, start or end time, episode field, channel group, or schedule coverage. Note the authorized editor and broad scope without exposing private source details.

## Separate submission from confirmation

Through the provider's official route, record edit submission time and the first time the new value became visible there. Do not assume those moments are the same or describe undocumented processing.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the source, identity, and time layers.

## Choose a minimal sample

Select up to three changed listings and one unchanged control. Record masked channel identity, old and new title cues, start/end times, and source confirmation. Avoid exporting the entire schedule.

## Freeze guide context

Record account, profile, source, channel group, filters, search, selected date and guide window, device clock, named zone, UTC offset where visible, device, application version, and network.

## Record the Norva sequence

Note guide open time, any documented refresh request, visible acknowledgment, loading or completion state where shown, first old-value observation, first new-value observation, navigation, device sleep or resume, and every retry.

If only now-and-next text stays old, use the [now-and-next timeline](/blog/now-next-information-stale/).

## Observe without creating new sequences

Repeated refreshes, source re-edits, channel renames, device restarts, application-data clearing, and source removal make it difficult to connect a later result to the original event. Preserve the first sequence. Label a support-directed retry as a new test.

## Use timing language carefully

If current Norva support publishes an expected range, cite the current page at publication review. Otherwise write “not visible after the documented interval” and provide timestamps. Do not invent a service promise.

## Compare another supported device

Use the same account, profile, source, group, filters, guide window, and close timestamp. Record both clocks, zones, and application versions. The [cross-screen guide check](/blog/guide-works-on-one-device-only/) helps preserve equivalent contexts.

## Check item and channel identity

If the updated listing appears under another channel or duplicate-looking row, record both identifiers. A mapping change can look like delayed text. Do not edit channel identifiers to force the expected placement.

## Separate time conversion

If the new title appears but start times differ, record clock, zone, offset, and guide window separately. A delayed field and a time-context mismatch can coexist.

## Classify the sequence

Use source edit not confirmed, source confirmed and Norva still old, one field updated while another stayed old, changed on one device first, appeared under another channel, changed after documented refresh, changed without user action during observation, or unknown. Do not assign a mechanism.

## Prepare support evidence

Use the [guide evidence template](/blog/guide-issue-support-evidence/) with edit and confirmation times, old and new cues, channel samples, stable context, devices, versions, observation points, and action log.

## Original evidence: source-to-guide timeline

| Event | Time and zone | Source value | Norva value | Device/action |
| --- | --- | --- | --- | --- |
| Edit submitted |  |  |  |  |
| Source confirmed |  |  |  |  |
| First Norva observation |  |  |  |  |
| Later observation |  |  |  |  |
| Other device |  |  |  |  |
| Retry if directed |  |  |  |  |

## Common mistakes and limitations

- Using edit submission as source confirmation.
- Repeating refreshes before preserving the first sequence.
- Changing filters or guide window during observation.
- Inventing a refresh deadline.
- Ignoring channel identity and time context.
- Sharing complete source schedules.

## Frequently asked questions

### How long should a guide update take?

Use current official Norva guidance if it states a range. Otherwise report exact elapsed observations and ask support.

### Should I refresh repeatedly?

No. Preserve the initial sequence and repeat only when current support guidance requests a controlled test.

### What if one field updates but another does not?

Record each field separately by view and time. Partial change is useful evidence without revealing why it occurred.

## Your next step

[Review Refresh Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
