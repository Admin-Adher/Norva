---
content_id: "NVB-975"
title: "Audit Subtitle and Accessibility Preferences Across Devices"
seo_title: "Audit Subtitle Preferences Across Devices"
meta_description: "Audit subtitle access across devices with known source tracks, selection, text timing, real-distance readability, returns, fallbacks, and evidence."
slug: "subtitle-accessibility-preference-audit"
canonical_url: "https://norva.tv/blog/subtitle-accessibility-preference-audit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "cross-device-subtitle-accessibility-audit"
topic_cluster: "Media App Maintenance & Audits"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I review subtitle accessibility preferences across devices?"
supporting_questions:
  - "How can source track presence, selection, readability, timing, preference, and screen context be separated?"
  - "Which subtitle failures should trigger an accessibility stop condition?"
audience:
  - "Viewers who rely on subtitles or captions"
  - "Households maintaining accessible cross-device viewing"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A subtitle accessibility audit confirms source tracks, selection, visible text, timing, real-distance readability, preference behavior, and acceptable fallback on each required screen."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-app-maintenance-audit-handbook/"
related_articles:
  - "/blog/media-app-maintenance-audit-handbook/"
  - "/blog/norva-for-caption-dependent-viewing/"
  - "/blog/norva-for-multilingual-households/"
  - "/blog/subtitle-badge-disagrees-track-list/"
  - "/blog/evaluate-norva-cross-screen-continuity/"
cta:
  label: "Review Norva Accessibility Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#faq"
  - "https://norva.tv/support"
  - "https://www.w3.org/WAI/media/av/captions/"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "cross-device subtitle accessibility matrix"
  summary: "A matrix records source-confirmed text tracks, item and scene, profile, supported screen, selection path, visible text, timing, viewing-distance readability, clean-return result, fallback, stop condition, and owner."
  methodology: "The viewer who depends on text selects three known samples, holds item and profile context stable, checks actual text and timing on each required screen, uses only verified controls, and treats an essential access failure as a stop condition."
  asset_urls: []
---

# Audit Subtitle and Accessibility Preferences Across Devices

> **In short:** Use media whose subtitle or caption tracks are confirmed at the authorized source, then repeat the same item, scene, profile, and track on each required supported screen. Check discovery, selection, visible text, timing, readability at normal distance, clean return, and preference behavior. Use only verified controls. A missing or unusable essential text track is a stop condition, not a weakness to average away.

Subtitle maintenance is an accessibility task when a viewer depends on text. Norva can retain language and subtitle preferences, but available tracks depend on the source and media. The audit must therefore test both source presence and real presentation on each required screen.

## Define the access requirement

Write the required language or text type, affected viewer, required screens, normal viewing distance, acceptable fallback, and stop condition. Do not use a general goal such as “subtitles preferred” when the viewer cannot use the media without them.

The [caption-dependent evaluation](/blog/norva-for-caption-dependent-viewing/) helps set the original requirement; this audit maintains it over time.

## Build a known source sample

Choose three items with confirmed source tracks and different dialogue patterns: ordinary conversation, rapid speech, and speaker changes or background sound. Record neutral item codes, track labels, and distinctive scenes.

If a displayed badge disagrees with the list, follow the [subtitle track verification path](/blog/subtitle-badge-disagrees-track-list/) before judging preference behavior.

## Hold identity and profile stable

Use the same account, profile, source, exact item version, scene, and track. Grouped variants can have different subtitle sets. Record screen and application or browser version, input method, time, and viewing distance.

Do not compare another episode or similarly named version and call it a device difference.

## Verify selection and visible text

Open the normal track control, select the intended track, and confirm actual text appears in the distinctive scene. Record the displayed label, visible language, and whether speaker or sound information needed by the viewer is present. Do not infer success from a highlighted option alone.

Available content depends on the supplied track; the audit does not claim Norva generates missing text.

## Check timing and continuity

Observe whether text appears usefully with the relevant speech, remains long enough for the viewer, and avoids obvious drift across the short sample. Repeat after seeking to another known cue. This is a reproducible user test, not a laboratory timing measurement.

If the source text itself is mistimed, record that boundary separately.

## Judge readability in context

On TV, sit at normal distance; on mobile, use the usual handheld distance; in Web, use the normal window and zoom context. Check contrast against bright and dark scenes, line visibility, obstruction by controls, truncation, and reading comfort.

Use styling or accessibility controls only when they are currently visible and documented. Do not invent a Norva customization feature.

## Test clean return and preference

Exit normally, return to the same item, and inspect the actual selected track. Then open another known item. Where a preference exists, record whether the observed result matches it. A preference cannot create a missing track.

For multilingual needs, use the [multilingual household evaluation](/blog/norva-for-multilingual-households/) to distinguish language preference from caption dependence.

## Compare required supported screens

Repeat the same sample on each essential screen. Norva supports preference continuity on supported devices, but the exact item and track must remain available. Use the [cross-screen method](/blog/evaluate-norva-cross-screen-continuity/) to align timestamps and context without claiming a fixed synchronization speed.

Do not let a mobile pass override an essential TV failure.

## Set fallback and escalation

Define an acceptable alternate track or another authorized item. If none exists, stop. For support, provide neutral item and scene codes, source-confirmed track labels, selected version, screen context, versions, timing observation, and a redacted image only when necessary.

Rerun after material source, application, or device updates and record it in the [maintenance handbook](/blog/media-app-maintenance-audit-handbook/).

## Original evidence: subtitle accessibility matrix

| Item and track | Profile | Screen and distance | Visible and timed | Readable | Return result | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Sample A |  |  |  |  |  |  |
| Sample B |  |  |  |  |  |  |
| Sample C |  |  |  |  |  |  |

## Common mistakes and limitations

- Testing tracks not confirmed at the source.
- Trusting a label without visible text.
- Evaluating TV text from beside the screen.
- Assuming a preference creates a missing track.
- Averaging away an essential failure.
- Claiming styling controls that are not documented.

## Frequently asked questions

### Can Norva supply a subtitle track that the source lacks?

Do not assume so. The available languages and text tracks depend on the source and media.

### Does one readable scene prove the entire item?

No. Use several distinctive cues and a small varied item sample, then record the scope of the result.

### Who decides whether readability passes?

The viewer who depends on the text should judge the actual screen and environment; the administrator records that decision without replacing it.

## Your next step

[Review Norva Accessibility Features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva FAQ](https://norva.tv/#faq)
- [Norva support](https://norva.tv/support)
- [W3C WAI: Captions and subtitles](https://www.w3.org/WAI/media/av/captions/)
