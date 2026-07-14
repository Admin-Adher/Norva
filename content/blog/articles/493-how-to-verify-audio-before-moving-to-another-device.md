---
content_id: "NVB-493"
title: "How to Verify Audio Before Moving to Another Device"
seo_title: "Verify Audio Before Moving Playback to Another Device"
meta_description: "Before moving playback, record the source, item, version, profile, exact audio label, heard role, and progress; then verify the destination independently."
slug: "how-to-verify-audio-before-moving-to-another-device"
canonical_url: "https://norva.tv/blog/how-to-verify-audio-before-moving-to-another-device/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "handoff-workflow"
topic_cluster: "Audio Track Management"
search_intent: "audio track pre-handoff check"
funnel_stage: "retention"
primary_question: "How should a viewer verify audio before continuing playback on another device?"
supporting_questions:
  - "Which source-device context should be recorded?"
  - "How can the destination check separate track availability from persistence?"
audience:
  - "Viewers moving between supported devices"
  - "Households troubleshooting cross-device audio"
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
estimated_reading_minutes: 6
excerpt: "A source-to-destination audio handoff check that records track identity, progress, version, output, and independently verified destination behavior."
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
parent_pillar: "/blog/the-complete-guide-to-managing-audio-tracks/"
related_articles:
  - "/blog/the-complete-guide-to-managing-audio-tracks/"
  - "/blog/how-to-recheck-audio-after-resuming-playback/"
  - "/blog/what-to-check-when-an-audio-preference-does-not-persist/"
cta:
  label: "See How Norva Works Across Supported Devices"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#features"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "cross-device audio handoff card"
  summary: "A paired source-and-destination card distinguishes media identity, track availability, starting selection, heard output, progress, and device-route differences."
  methodology: "The viewer verifies a dialogue sample on the source, closes playback normally, opens the same account/profile/item/version on the destination, records state before correction, and changes no second variable."
  asset_urls: []
---
# How to Verify Audio Before Moving to Another Device

> **In short:** On the first device, confirm the account or profile, source, item, media version, progress point, exact audio label, and what is heard. On the destination, verify the same context before changing the track. Inspect whether the target entry exists, which entry starts, and what the output plays. Do not assume track selection transfers merely because progress does.

A cross-device handoff contains at least three separate questions: did the same media open, did progress transfer as expected, and did the audio context match? Test them separately.

## Record the source-device baseline

Before leaving Device A, capture:

- account and anonymised profile;
- source, item, season/episode, and media version;
- exact selected audio label;
- verified language or role from a short sample;
- approximate playback position;
- app or browser version;
- output route, such as device speakers or external equipment;
- online or eligible offline state.

Do not include credentials, source addresses, or unrelated viewing history.

## Close playback consistently

Use a normal exit route and allow the interface to return to a stable state. Do not force-close, clear data, or change the selected version as part of the handoff.

Record the route used. If a later problem depends on how playback was left, that detail makes the comparison reproducible.

## Verify the destination context

On Device B, confirm the same account or profile, source, item, episode, and media version. Check the playback point, but do not treat correct progress as proof that the audio track transferred.

Before correcting anything, open the audio selector and record the full relevant label and selected marker. Sample dialogue through the destination output.

## Original evidence: paired handoff card

| Field | Device A | Device B |
|---|---|---|
| Item/version | Exact context | Exact context |
| Playback point | Approximate | Opened point |
| Target entry available | Yes | Yes/no/unclear |
| Selected label | Exact text | Exact text |
| Heard language/role | Verified | Verified |
| Output route | Exact route | Exact route |

Classify differences as media identity, availability, selection, heard output, or progress. That prevents one symptom from hiding another.

## Interpret the result cautiously

If the target entry is absent on Device B, investigate version, source, supported-device exposure, or offline context. If it is present but another starts, investigate selection persistence. If the selector matches but the output differs, preserve the output route and do not change audio and hardware settings simultaneously.

These are investigation branches, not confirmed causes.

## Recheck resume behavior

When the destination opens through a continue item, use [the resume audio workflow](/blog/how-to-recheck-audio-after-resuming-playback/) to record the route and state. Repeat once only if the mismatch needs confirmation.

For recurring selection differences, use [the preference-persistence guide](/blog/what-to-check-when-an-audio-preference-does-not-persist/). The [complete audio-management guide](/blog/the-complete-guide-to-managing-audio-tracks/) maps version, episode, and offline boundaries.

## Plan for shared devices

Confirm the active profile before playback and avoid exposing another person's history on a shared screen. Ask before changing a household audio default. When finished on a borrowed or temporary device, follow the agreed sign-out and reopen check.

Profiles organise viewing context, but they do not prove private preferences or independent access rights.

## Report a cross-device difference

Provide both sides of the paired card, exact steps, local time zone, expected result, observed result, and whether the destination reproduced the issue. Include privacy-safe selector screenshots where authorised.

Do not claim that Device B is unsupported without checking current official compatibility information.

## Common mistakes and limitations

Avoid assuming progress and audio share the same persistence rule, comparing different versions, correcting before recording, and changing the output route during the test.

Cross-device behavior depends on current supported contexts and supplied media. The test establishes one reproducible path, not a universal device guarantee.

## Frequently asked questions

### If progress transfers, should audio transfer too?

Do not assume that relationship. Verify track availability and selection independently.

### What if the destination lacks the target track?

Confirm the exact version and context, then use a one-variable missing-track diagnostic.

### Should I test several destination devices?

Start with one. Add another only when it answers a defined device-specific question.

## Your next step

[See how Norva works across supported devices](https://norva.tv/#how-it-works)

## Sources

- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Features](https://norva.tv/#features)
- [Norva Support](https://norva.tv/support)
