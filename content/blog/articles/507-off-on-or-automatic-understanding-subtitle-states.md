---
content_id: "NVB-507"
title: "Off, On, or Automatic: Understanding Subtitle States"
seo_title: "Subtitle States Explained: Off, On, and Automatic"
meta_description: "Understand subtitle off, on, and automatic states by testing exact interface wording, selected tracks, ordinary dialogue, limited passages, and burned-in text."
slug: "off-on-or-automatic-understanding-subtitle-states"
canonical_url: "https://norva.tv/blog/off-on-or-automatic-understanding-subtitle-states/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "educational-guide"
topic_cluster: "Subtitle Management"
search_intent: "subtitle off on automatic states"
funnel_stage: "retention"
primary_question: "What do off, on, and automatic subtitle states mean in practical use?"
supporting_questions:
  - "How can each state be tested without assuming universal semantics?"
  - "How do state, selected track, forced role, and burned-in text differ?"
audience:
  - "Viewers choosing subtitle states"
  - "People diagnosing unexpected automatic text"
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
excerpt: "A controlled three-state test that separates selector state, chosen track, limited cue roles, automatic behavior, and text rendered into the picture."
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
parent_pillar: "/blog/the-complete-guide-to-managing-subtitle-tracks/"
related_articles:
  - "/blog/how-to-review-the-default-subtitle-selection/"
  - "/blog/forced-or-full-subtitles-how-the-tracks-differ/"
  - "/blog/the-complete-guide-to-managing-subtitle-tracks/"
cta:
  label: "Explore Norva's Player Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/webvtt1/"
  - "https://www.w3.org/TR/media-accessibility-reqs/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "three-state subtitle behavior card"
  summary: "A card tests off, one explicit track, and automatic against ordinary dialogue and a likely limited passage while preserving the selected media context."
  methodology: "The viewer records exact state wording, uses the same two scenes for each state, restores the baseline between tests, and reports automatic behavior only for the tested item/version."
  asset_urls: []
---
# Off, On, or Automatic: Understanding Subtitle States

> **In short:** Off generally requests no selectable subtitle track, on means an explicit track is active, and automatic asks the player to decide under supported conditions. Exact semantics vary by interface and media metadata. Test each state on the same item/version using ordinary dialogue and a scene likely to contain a limited cue. Burned-in text is unaffected.

State labels describe control behavior, while track labels describe available timed-text resources. Confusing the two makes troubleshooting imprecise.

Run the comparison with a title you are authorised to use and a scene whose cue pattern you already understand. A familiar baseline reduces the chance that an editorial gap, silent passage, or unfamiliar language is mistaken for a state-control result.

## Record the exact wording

The interface may use “off,” “none,” “on,” “automatic,” “auto,” a selected language, or another label. Capture the text rather than normalising it to a preferred term.

Also record the track shown as selected, because “on” without a track identity is incomplete evidence.

## Test off

Choose the off state and sample ordinary dialogue. If selectable cues disappear, record that result. If text remains, determine whether it is burned into the picture, part of the programme image, or an unexpected cue state.

Do not call permanent image text a subtitle-control failure.

## Test one explicit track

Select a clearly identified full subtitle or caption track. Use the same ordinary dialogue scene and verify text appears, matches the intended language, and corresponds reasonably with speech in the sample.

Record exact label and cue result. This establishes a reference for the automatic comparison.

## Test automatic

Choose the exact automatic state and sample:

1. ordinary dialogue that the selected context is likely to treat normally;
2. a foreign-language passage, sign, or other scene where a limited track might be relevant.

If text appears only in the second scene, record that observed pattern. Do not turn it into a universal rule or claim the internal trigger.

## Original evidence: three-state card

| State | Selected label | Ordinary dialogue | Limited passage | Interpretation |
|---|---|---|---|---|
| Off | Exact state | Cue result | Cue result | Observed only |
| Explicit on | Track label | Cue result | Cue result | Verified track |
| Automatic | Exact state | Cue result | Cue result | Tested-context behavior |

Repeat only when the result is inconsistent, keeping device, profile, version, and scene fixed.

## Keep forced role separate

A forced subtitle track is a media role; automatic is a player state. They may interact in some contexts, but one does not define the other.

Use [the forced-versus-full guide](/blog/forced-or-full-subtitles-how-the-tracks-differ/) to verify cue scope before explaining an automatic result.

## Review the starting state

If the title repeatedly opens in an unexpected state, use [the default subtitle review](/blog/how-to-review-the-default-subtitle-selection/) to compare visible preference, title choice, selected media, and shared-profile context.

The [complete subtitle-management guide](/blog/the-complete-guide-to-managing-subtitle-tracks/) covers resume, episode, version, device, and offline boundaries.

## Account for accessibility

Automatic selection may not satisfy someone who needs continuous captions or full subtitles. Choose an explicit verified track when continuous text is required. Ask the viewer; do not infer need from prior activity.

## Report unexpected behavior

Include exact state wording, full track list, item/version, two-scene timestamps, account or anonymised profile, device, app or browser version, steps, expected result, and observed result.

Redact credentials, source addresses, account email, and private history. Do not attach media.

## Common mistakes and limitations

Avoid equating off with absence of burned-in text, calling automatic a track, assuming forced cues always trigger, and comparing states on different versions.

Current interface semantics and supplied metadata determine behavior. This test documents one context rather than a universal product rule.

## Frequently asked questions

### Why does automatic show nothing during dialogue?

That may be expected for the tested context, or no relevant limited track may exist. Inspect the list and test a suitable scene.

### Can off still show foreign-language text?

Text may be burned into the image or the current product may handle a limited track under a documented rule. Record evidence before assigning a cause.

### Is on the same as choosing a language?

An active state still needs a track identity. Record both the state and exact label.

## Your next step

[Explore Norva's player features](https://norva.tv/#features)

## Sources

- [W3C: WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)
- [Norva Features](https://norva.tv/#features)
