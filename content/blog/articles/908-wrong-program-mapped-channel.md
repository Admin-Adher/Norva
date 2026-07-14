---
content_id: "NVB-908"
title: "Wrong Program Mapped to a Channel? Verify Both Identities"
seo_title: "Wrong Program on a Channel? Verify Identities"
meta_description: "Troubleshoot channel-program mapping by comparing source and Norva identifiers, schedules, program cues, time context, adjacent channels, and devices."
slug: "wrong-program-mapped-channel"
canonical_url: "https://norva.tv/blog/wrong-program-mapped-channel/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "channel-program-mapping-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot incorrect channel program mapping?"
supporting_questions:
  - "Which source and Norva channel identifiers, schedules, program cues, time context, adjacent channels, and device evidence should be compared?"
  - "How can a mapping issue be separated from a wrong schedule or live-state mismatch?"
audience:
  - "Norva users seeing another channel's program listing"
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
excerpt: "A channel-program mapping check pairs source and Norva channel identity cues with schedule records, program cues, adjacent channels, time context, devices, and timeline."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/duplicate-channels-in-guide/"
  - "/blog/program-start-time-disagrees-live/"
  - "/blog/one-channel-guide-others-blank/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Use Norva Support"
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
  type: "channel and program identity crosswalk"
  summary: "A crosswalk records source and Norva channel names, numbers or identifiers, logos, regions or versions, current and adjacent program cues, schedule times, device clock and zone, neighboring channel evidence, device and application version, and timeline."
  methodology: "The user identifies affected and candidate channels independently, compares their source schedules and Norva rows at the same time, checks duplicates and adjacent channels, and avoids remapping or renaming before support review."
  asset_urls: []
---

# Wrong Program Mapped to a Channel? Verify Both Identities

> **In short:** Identify the affected channel and the channel whose program appears to be shown. For both, record source label, visible name, number or identifier, logo, region or version cue, source schedule, Norva row, program title cue, start and end times, device clock and zone, device, application version, and timestamp. Compare adjacent channels and duplicates. Do not remap, rename, or delete channels before preserving the crosswalk.

A wrong-looking listing can come from a channel identity mismatch, duplicated channel, shifted time, stale program text, or incorrect source schedule. Verifying both the channel and program prevents a same-name assumption.

## Name the affected and candidate channels

Record privacy-safe labels for channel A and the channel B whose program appears under A. Include visible source, number or identifier, logo, region, language, and version cues. Do not rely on logo or display name alone.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the identity matrix.

## Capture both source schedules

Through the provider's official authorized route, record current, previous, and next program title cues and start/end times for A and B at the same timestamp. Note explicit time-zone labels without inferring unlabeled semantics.

## Capture both Norva rows

Record channel label, program cue, start/end times, row position, and detail view for A and B. A title from B under A is stronger mapping evidence when B's source schedule matches the misplaced listing.

## Check duplicate channels

Search for repeated names, numbers, logos, or source versions. Use the [duplicate-channel comparison](/blog/duplicate-channels-in-guide/) to distinguish a legitimate alternate source or regional version from an apparent duplicate.

## Check adjacent row displacement

Compare the channel immediately above and below A. If several rows appear shifted together, record the sequence. Do not infer an index or ordering error; preserve visible row identities and program cues.

## Verify time context

Record device clock, named zone, UTC offset where visible, selected guide date, and window. If program times are uniformly shifted but channel rows remain correct, use the [start-time guide](/blog/program-start-time-disagrees-live/) instead of a mapping classification.

## Compare program identity carefully

Use short title, episode or event cue, description fragment, and schedule boundary. Do not copy full descriptions or media. A generic program title may not uniquely identify a listing.

## Compare a control channel

Choose one unrelated channel whose source and Norva schedules align. Record identical fields. A normal control narrows scope but does not prove how mapping is performed.

## Compare another supported device

Use the same account, profile, source, channel group, filters, guide window, and close timestamp. Record both application versions. If the same mapping appears, record cross-device consistency without naming an internal cause.

## Preserve source and guide changes

Record source update, import or refresh, channel rename, application update, first mismatch, retries, and current state. If only one channel lacks data, use the [partial coverage guide](/blog/one-channel-guide-others-blank/).

## Avoid remapping by guess

Do not rename channel identifiers, swap schedule records, delete a duplicate-looking row, edit logos, remove the source, or repeat refreshes before evidence capture. A guessed correction can affect legitimate channels.

## Classify the result

Use wrong channel identity selected, source schedule for A differs, program from B appears under A, adjacent rows shifted, duplicate source version, time-context issue, text-only stale listing, device-specific mapping, or unknown. Avoid claims about matching fields or priority.

## Prepare support evidence

Use the [guide evidence template](/blog/guide-issue-support-evidence/) with A/B crosswalk, source and Norva schedule samples, time context, adjacent rows, devices, versions, timeline, and actions.

## Original evidence: channel-program crosswalk

| Field | Channel A | Candidate B | Control |
| --- | --- | --- | --- |
| Source and visible identifier |  |  |  |
| Name, logo, region/version |  |  |  |
| Source current/next |  |  |  |
| Norva current/next |  |  |  |
| Start/end and time context |  |  |  |
| Row position |  |  |  |
| Device, version, time |  |  |  |

## Common mistakes and limitations

- Matching channels by display name or logo alone.
- Comparing source schedules at different times.
- Ignoring duplicate and adjacent channels.
- Treating a time shift as channel mapping.
- Renaming or deleting rows before evidence capture.
- Sharing a complete private channel lineup.

## Frequently asked questions

### Does the logo uniquely identify a channel?

No. Combine source, visible identifiers, region or version, schedule, and row evidence.

### Should I rename the channel to match the program?

No. Preserve both identities and ask the source owner or Norva support before changing metadata.

### What if only the program title is wrong?

Record time and description fields. A text-only mismatch may belong to stale or incorrect schedule metadata rather than mapping.

## Your next step

[Use Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [IANA Time Zone Database](https://www.iana.org/time-zones)
