---
content_id: "NVB-531"
title: "How to Review Caption Timing Without Guessing"
seo_title: "How to Review Caption Timing Without Guessing"
meta_description: "Review caption timing across speech, speaker changes, sound cues, music, and scene transitions by recording onset, duration, pattern, viewer outcome, and context."
slug: "how-to-review-caption-timing-without-guessing"
canonical_url: "https://norva.tv/blog/how-to-review-caption-timing-without-guessing/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "accessibility-audit"
topic_cluster: "Caption Accessibility"
search_intent: "caption timing accessibility review"
funnel_stage: "retention"
primary_question: "How can caption timing be reviewed without guessing?"
supporting_questions:
  - "Which speech, speaker, sound, music, and scene-transition cues should be sampled?"
  - "How can onset, duration, reading completion, and repeatable patterns be recorded?"
audience:
  - "Viewers experiencing caption timing barriers"
  - "Product and support teams auditing caption synchronisation"
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
excerpt: "A multi-scene caption timing audit for cue onset, duration, speaker changes, sound events, reading completion, and pattern classification."
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
parent_pillar: "/blog/the-complete-guide-to-caption-accessibility/"
related_articles:
  - "/blog/when-caption-reading-speed-becomes-a-barrier/"
  - "/blog/subtitles-early-or-late-build-a-timing-diagnosis/"
  - "/blog/the-complete-guide-to-caption-accessibility/"
cta:
  label: "Contact Norva Support With Timing Evidence"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/media-accessibility-reqs/"
  - "https://www.w3.org/TR/webvtt1/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "caption timing accessibility scene set"
  summary: "A seven-scene set captures cue onset, disappearance, event relationship, reading completion, overlap, and viewer outcome across dialogue, sound, music, and transitions."
  methodology: "The reviewer fixes playback context, samples beginning, middle, and end, uses one timing convention, asks the user to complete reading tasks, and avoids a universal numeric threshold."
  asset_urls: []
---
# How to Review Caption Timing Without Guessing

> **In short:** Fix item, version, track, device, state, and playback speed. Sample at least seven cues across dialogue, speaker changes, off-screen sounds, music, and scene transitions. Record when the event begins, when the cue appears and disappears, whether the viewer finishes reading, and whether the same pattern repeats. Do not judge timing from one cue or invent a universal tolerance.

Caption timing supports more than word-to-speech alignment. It helps readers connect speakers, sound cues, music, reactions, and visual events while retaining enough time to read.

## Choose a representative scene set

Include:

- ordinary dialogue;
- rapid turn-taking;
- overlapping speech;
- an off-screen sound;
- music or a sound transition;
- a scene cut during a cue;
- one dense cue near the end of the title.

Spread samples across beginning, middle, and end to reveal drift or isolated errors.

## Fix the context

Record source, item/version, caption label, state, account or anonymised profile, device, app or browser version, playback speed, online or eligible offline state, and output context.

Do not change size or line wrapping during the first timing review unless those are the question.

## Use one timing convention

Define early and late relative to a clear speech or sound event. Record approximate differences only when the playback interface supports a meaningful observation. Do not report false precision.

For cue duration, record whether the viewer completes reading before disappearance rather than assuming a number proves usability.

## Original evidence: timing scene set

| Scene | Event | Cue onset | Cue end | Early/late pattern | Reading completed? | Meaning connected? |
|---|---|---|---|---|---|---|
| Dialogue | Speech start | Observation | Observation | Result | Yes/no | Yes/no |
| Speaker change | New voice | Result | Result | Result | Result | Result |
| Sound | Event | Result | Result | Result | Result | Result |
| Music | Change | Result | Result | Result | Result | Result |

Add scene-cut and dense-cue rows using the same fields.

## Distinguish timing patterns

- **constant offset:** cues show a similar direction and approximate difference;
- **progressive drift:** the difference grows across the title;
- **short duration:** cue relation is acceptable but reading cannot finish;
- **event mismatch:** sound or speaker cue attaches to the wrong moment;
- **isolated error:** one cue differs while others work;
- **non-repeatable:** replay changes the observed result.

These describe the barrier, not its internal cause.

## Connect timing to reading speed

A dense cue can feel mistimed because its display time is insufficient for the viewer, even when onset aligns. Use [the caption reading-speed guide](/blog/when-caption-reading-speed-becomes-a-barrier/) to separate text load from offset.

Do not solve density by shrinking text until it is unreadable.

## Use the subtitle offset method when appropriate

For a suspected global early or late track, [the subtitle timing diagnosis](/blog/subtitles-early-or-late-build-a-timing-diagnosis/) provides a five-cue offset worksheet. Caption review adds speaker, sound, music, and reading outcomes.

The [complete caption accessibility guide](/blog/the-complete-guide-to-caption-accessibility/) connects timing with coverage, size, contrast, and placement.

## Ask users directly

Invite caption users to explain where meaning was lost or reading could not finish. Do not speak for them, require disability disclosure, or convert one person's result into a universal threshold.

## Report a timing barrier

Include the scene set, exact context, playback speed, timestamps, expected accessible relationship, observed pattern, and privacy-safe screenshots. Describe rather than attach media or full caption resources.

## Common mistakes and limitations

Avoid reviewing dialogue only, using ambiguous event boundaries, changing speed, and claiming one numeric offset is unacceptable for every viewer.

The supplied caption resource, media timeline, player, and device can all affect observed timing. Evidence can narrow the boundary without proving root cause.

## Mark entry, exit, and handoff separately

For each suspect cue, note when the relevant sound begins, when readable text appears, when the sound ends, and when the caption disappears. Then inspect the handoff to the next cue. This separates late entry, premature removal, lingering text, and collision between speakers. Repeat at normal playback speed after any frame-level inspection, because a technically aligned boundary can still produce a confusing reading sequence in motion.

## Frequently asked questions

### How many cues should be reviewed?

Seven varied cues are a practical start; add more when drift, density, or mixed patterns appear.

### Is synchronisation only about cue onset?

No. Duration, disappearance, speaker changes, sounds, music, and reading completion also matter.

### Should I adjust a delay control first?

Preserve the baseline and use only supported controls after the original pattern is documented.

## Your next step

[Contact Norva Support with timing evidence](https://norva.tv/support)

## Sources

- [W3C: Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)
- [W3C: WebVTT](https://www.w3.org/TR/webvtt1/)
- [Norva Support](https://norva.tv/support)
