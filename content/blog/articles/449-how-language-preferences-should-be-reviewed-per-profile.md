---
content_id: "NVB-449"
title: "How Language Preferences Should Be Reviewed Per Profile"
seo_title: "Review Language Preferences for Each Household Profile"
meta_description: "Review audio and subtitle intent per profile with a reference item, separate preference from track availability, and verify behaviour on supported screens."
slug: "how-language-preferences-should-be-reviewed-per-profile"
canonical_url: "https://norva.tv/blog/how-language-preferences-should-be-reviewed-per-profile/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Household Profiles"
search_intent: "per-profile language preference review"
funnel_stage: "consideration"
primary_question: "How should language preferences be reviewed for each household profile?"
supporting_questions:
  - "How are audio and subtitle preferences different?"
  - "What if the preferred track is missing?"
audience:
  - "Multilingual households using separate profiles"
  - "Viewers reviewing audio and subtitle defaults"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#pricing; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Review audio and subtitle intent per profile with a reference item, separate preference from track availability, and verify behaviour on supported screens."
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
parent_pillar: "/blog/the-complete-guide-to-household-media-profiles/"
related_articles:
  - "/blog/the-complete-guide-to-household-media-profiles/"
  - "/blog/how-to-preserve-an-audio-choice-during-a-device-handoff/"
  - "/blog/how-to-preserve-subtitle-context-during-a-device-handoff/"
cta:
  label: "Explore Norva's Language and Subtitle Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.w3.org/WAI/media/av/captions/"
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "per-profile language intent card"
  summary: "A reference-item review separates preferred audio, subtitle on/off intent, fallback choice, actual track availability, and cross-device verification."
  methodology: "Each profile uses the same authorised reference item when possible, records visible tracks, selects only available choices, and repeats the check on one other supported screen."
  asset_urls: []
---
# How Language Preferences Should Be Reviewed Per Profile

> **In short:** Give each profile an explicit audio preference, subtitle on/off intent, subtitle language, and fallback choice. Test those preferences with a known item and version, then repeat on another supported screen. Treat preference and availability separately: Norva can preserve choices, but the source and media determine which audio and subtitle tracks actually exist.

A household profile should reflect the viewer's usual intent without forcing every item into the same track. A review makes fallback decisions clear when media options differ.

## Separate four decisions

Record independently:

1. preferred audio language or track;
2. subtitle on or off intent;
3. preferred subtitle language;
4. fallback when the preferred track is absent.

Do not infer subtitle choice from audio choice. One viewer may prefer original audio with subtitles; another may prefer available dubbed audio without subtitles.

## Choose a reference item

Use an authorised item with clearly labelled audio and subtitle choices. Record its version or source label because another variant may offer different tracks.

Do not use one item to claim universal availability. The reference tests profile behaviour only where those tracks exist.

## Verify the active profile

Read the profile label before opening settings or playback. A wrong-profile change can persist as another person's preference.

The [household profile guide](/blog/the-complete-guide-to-household-media-profiles/) provides naming and pre-play checks.

## Record visible choices

Open audio and subtitle controls while paused. Transcribe labels exactly. Mark missing or abbreviated labels uncertain.

W3C caption guidance explains the accessibility purpose of captions, including speech and relevant non-speech information. It does not certify a particular source track.

## Select the intended available state

Choose the profile's preference only from tracks actually shown. Play a short section with dialogue, then verify language, subtitle display, and approximate position.

Use a section where spoken content and, when relevant, meaningful non-speech audio make the track state observable. A silent title sequence cannot confirm language or caption behaviour. Pause after the check so the reference item does not accumulate unnecessary progress.

Use [the audio-choice handoff workflow](/blog/how-to-preserve-an-audio-choice-during-a-device-handoff/) to keep media track separate from speaker or headphone output.

## Check another supported screen

Move the same profile, item, and version to another supported device. Verify the visible audio and subtitle state before resuming. If the preference does not appear, first check item, version, and target track availability.

The [subtitle-context handoff guide](/blog/how-to-preserve-subtitle-context-during-a-device-handoff/) provides a source-target card.

## Define a fallback

When the preferred track is absent, choose a household-approved rule such as:

- remain paused and choose manually;
- use a named available audio alternative;
- use a named available subtitle alternative;
- stop and select another authorised version.

The rule should not pretend a missing track can be created.

Record whether the fallback is temporary for that item or intended as the profile's general response. This prevents one unusual source version from silently redefining the profile's normal preference.

## Original evidence: language intent card

| Profile | Preferred audio | Subtitle intent | Preferred subtitles | Fallback | Reference test |
| --- | --- | --- | --- | --- | --- |
|  |  | On / Off / Decide per item |  |  |  |
|  |  | On / Off / Decide per item |  |  |  |

Add item, version, source-screen result, target-screen result, and review date. Avoid sensitive profile labels in notes stored on shared devices.

## Review after a real change

Repeat the card when a viewer's needs change, a profile is created, a source version changes, or the interface changes materially. Do not alter a displayed review date without a substantive review.

## Common mistakes and limitations

Avoid assuming all media has the preferred track, treating audio and subtitles as one setting, changing the wrong profile, and using one reference item as a compatibility guarantee.

Track labels, quality, and availability depend on the source and media. This workflow cannot certify translation accuracy or create missing tracks.

## Frequently asked questions

### Should every profile have one fixed language?

Not necessarily. Record a default intent and an explicit “decide per item” option when needs vary.

### Do subtitle preferences guarantee subtitles?

No. The selected version must contain the requested track.

### Why test another screen?

It verifies the actual target state and reveals whether a mismatch comes from version availability or profile selection.

## Your next step

[Explore Norva's language and subtitle features](https://norva.tv/#features)

## Sources

- [W3C WAI: Captions](https://www.w3.org/WAI/media/av/captions/)
- [Norva Features](https://norva.tv/#features)
- [Norva: How It Works](https://norva.tv/#how-it-works)
