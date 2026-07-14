---
content_id: "NVB-528"
title: "How to Keep Captions Clear of Important Visual Content"
seo_title: "Keep Captions Clear of Important Visual Content"
meta_description: "Review caption placement against faces, signs, lower-thirds, controls, and action; test supported positioning without creating unstable movement or hiding information."
slug: "how-to-keep-captions-clear-of-important-visual-content"
canonical_url: "https://norva.tv/blog/how-to-keep-captions-clear-of-important-visual-content/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "placement-audit"
topic_cluster: "Caption Accessibility"
search_intent: "caption position visual overlap"
funnel_stage: "retention"
primary_question: "How can captions avoid covering important visual content?"
supporting_questions:
  - "Which visual regions and scenes should be audited?"
  - "How can placement changes balance occlusion, stability, and speaker association?"
audience:
  - "Viewers encountering caption overlap"
  - "Product teams auditing timed-text placement"
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
excerpt: "A scene-map audit for caption overlap with faces, signs, lower-thirds, controls, action, speaker position, and changing aspect ratios."
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
  - "/blog/two-lines-or-three-evaluate-caption-block-height/"
  - "/blog/how-to-choose-a-readable-caption-size/"
  - "/blog/the-complete-guide-to-caption-accessibility/"
cta:
  label: "Explore Norva's Player Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.w3.org/TR/media-accessibility-reqs/"
  - "https://www.w3.org/TR/webvtt1/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "caption visual-overlap scene map"
  summary: "A scene map records caption region, essential visual content, overlap duration, supported alternative placement, reading outcome, and movement cost."
  methodology: "The evaluator samples faces, signs, lower-thirds, controls, and action, keeps size and styling fixed, tests only supported placement, and asks viewers to complete both reading and visual-information tasks."
  asset_urls: []
---
# How to Keep Captions Clear of Important Visual Content

> **In short:** Audit captions against faces, speaker cues, signs, lower-thirds, controls, and essential action. Record where overlap occurs and whether supported placement can move the caption without harming readability or creating distracting jumps. Keep size and styling fixed during the first test. Do not assume bottom-centre placement works for every scene or aspect ratio.

Captions and visual information are both part of the viewing task. Preventing overlap is not about preserving a pristine picture at the expense of readable text; it is about keeping both channels usable.

Ask the viewer which visual details mattered after each sample instead of deciding from a paused frame alone.

## Define important visual content

Include content needed to understand or operate the experience:

- speaker faces and expressions;
- on-screen signs or messages;
- names, locations, and lower-thirds;
- playback controls and status messages;
- action that changes meaning;
- diagrams, scores, or other programme information.

Decorative background detail may be lower priority, but ask the viewer when uncertain.

## Build a scene sample

Choose scenes with each content type plus a normal dialogue baseline. Record item/version, track, device, viewport or aspect ratio, caption size, lines, background treatment, and placement.

Keep these fixed before testing an alternative position.

## Map overlap precisely

For each cue, record:

- caption region;
- visual content covered;
- duration of overlap;
- whether the covered information appears elsewhere;
- whether the viewer missed text, visual information, or both;
- supported alternative placement.

A screenshot can document the frame, but replay at normal speed to assess the real task.

## Original evidence: scene map

| Scene | Caption region | Content overlapped | Duration | Alternative tested | Reading result | Visual result |
|---|---|---|---|---|---|---|
| Face | Bottom/other | Expression | Approximate | Supported position | Result | Result |
| Sign | Region | Written text | Result | Result | Result | Result |
| Lower-third | Region | Name/title | Result | Result | Result | Result |
| Action | Region | Event | Result | Result | Result | Result |

Use “not movable” when current supported controls provide no alternative.

## Balance stability and movement

Moving captions can reveal covered content and associate text with speakers, but frequent jumps can increase search effort. Prefer a stable alternative within a scene when possible. Avoid moving every cue in response to minor background changes.

Do not claim the player can reposition cues unless the current track and interface support it.

## Consider block height and size

A three-line block or larger text covers more of the image. Use [the caption block-height guide](/blog/two-lines-or-three-evaluate-caption-block-height/) to distinguish placement from density.

Use [the readable size guide](/blog/how-to-choose-a-readable-caption-size/) before shrinking text solely to avoid overlap. Unreadable text is not a valid placement fix.

## Test responsive and device contexts

Aspect ratio, viewport, safe areas, and physical display can change the apparent overlap. Recheck phone, resizable browser, and TV only where relevant and supported. Keep media version and track constant.

The [complete caption accessibility guide](/blog/the-complete-guide-to-caption-accessibility/) connects placement with content coverage, timing, contrast, and controls.

## Report a placement barrier

Include timestamps, scene map, exact device/viewport, size, line count, supported placement options, expected outcome, and observed missed information. Use privacy-safe screenshots without exposing account or source data.

Do not attach media or copy substantial caption text.

## Common mistakes and limitations

Avoid testing one frame, shrinking text until unreadable, moving captions so often that users must search, and blaming player placement when source-authored positioning is unverified.

Supplied cue positioning and current renderer controls both matter. Evidence can locate the visible boundary without proving the internal owner.

## Build a scene-level obstruction log

For every overlap, record the timecode, caption block, covered visual element, why that element matters to the scene, and whether another supported position preserves both. Include faces, signed communication, written translations, scores, maps, diagrams, and interface prompts where relevant. Ask the viewer which visual details supported their understanding before deciding that an overlap is harmless. Do not move captions based on aesthetics alone; movement can create a new reading burden across consecutive cues.

## Frequently asked questions

### Should captions always stay at the bottom?

No universal placement fits every scene. Use stable supported alternatives when important content is covered.

### Is moving captions near the speaker always better?

It can help association, but frequent movement may increase search effort. Test viewer outcomes.

### Should text be made smaller to avoid overlap?

Only if it remains comfortably readable. Evaluate size, line breaks, and placement together.

## Your next step

[Explore Norva's player features](https://norva.tv/#features)

## Sources

- [W3C: Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)
- [W3C: WebVTT](https://www.w3.org/TR/webvtt1/)
- [Norva Features](https://norva.tv/#features)
