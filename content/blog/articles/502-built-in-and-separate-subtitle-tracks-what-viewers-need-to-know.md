---
content_id: "NVB-502"
title: "Built-In and Separate Subtitle Tracks: What Viewers Need to Know"
seo_title: "Built-In vs Separate Subtitle Tracks Explained"
meta_description: "Understand embedded, separate, and burned-in subtitle text, how each is associated with media, what remains selectable, and which support assumptions to avoid."
slug: "built-in-and-separate-subtitle-tracks-what-viewers-need-to-know"
canonical_url: "https://norva.tv/blog/built-in-and-separate-subtitle-tracks-what-viewers-need-to-know/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "comparison-guide"
topic_cluster: "Subtitle Management"
search_intent: "built-in vs separate subtitle tracks"
funnel_stage: "consideration"
primary_question: "What should viewers know about built-in and separate subtitle tracks?"
supporting_questions:
  - "How do embedded, separate, and burned-in text differ?"
  - "How can a missing association be diagnosed without assuming import support?"
audience:
  - "Viewers comparing subtitle packaging"
  - "People troubleshooting missing selectable text"
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
excerpt: "A practical comparison of embedded, separately associated, and burned-in subtitle text with safe verification steps."
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
  - "/blog/the-complete-guide-to-managing-subtitle-tracks/"
  - "/blog/how-to-investigate-a-missing-subtitle-track/"
  - "/blog/how-a-version-change-can-alter-subtitle-availability/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "consideration"
sources:
  - "https://www.w3.org/TR/webvtt1/"
  - "https://www.w3.org/WAI/media/av/"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "subtitle packaging identification card"
  summary: "A card distinguishes embedded selectable tracks, separately associated timed text, and text rendered into the picture through selector and playback evidence."
  methodology: "The viewer records the untouched selector, toggles text once, changes only the media version when needed, and labels packaging as confirmed only when evidence supports it."
  asset_urls: []
---
# Built-In and Separate Subtitle Tracks: What Viewers Need to Know

> **In short:** Embedded subtitle tracks travel inside the media container; separate tracks are distinct timed-text resources associated with the media; burned-in text is part of the picture and cannot be toggled as a track. Whether a player discovers a separate resource depends on the connected source, association, format, metadata, and current support. Verify the selector instead of assuming import behavior.

“Built-in” is often used loosely. To troubleshoot accurately, distinguish selectable embedded text from text rendered permanently into the image.

## Define the three practical categories

- **Embedded selectable track:** timed text packaged inside the media container and exposed as a choice when supported.
- **Separate associated track:** a timed-text resource stored apart from the media and linked through the source or playback context.
- **Burned-in text:** pixels already present in the video image; no selector can turn them off independently.

These categories describe packaging, not quality or accessibility completeness.

## Identify the category through behavior

Open the subtitle selector and record all entries. Select one and sample a dialogue scene. Turn subtitle state off through the available control.

If the text responds to the selector, it is a selectable track in that context. If text remains because it is part of the picture, it may be burned in. Do not conclude packaging from the visual style alone.

## Treat separate-track support as conditional

A separate resource needs a valid association with the item and a format the source and player context support. The exact mechanism may involve source metadata or another documented relationship.

Do not promise that Norva accepts arbitrary local files, matches filenames, or imports a format unless the current official feature documentation says so. Norva's published description should remain the source of truth.

## Original evidence: packaging card

| Evidence | Result |
|---|---|
| Exact item/version | Visible identity |
| Selector before playback | Complete list |
| Track chosen | Exact label |
| State off result | Text disappears, remains, or unclear |
| Another version | Same or different list |
| Packaging conclusion | Embedded, separate, burned-in, or unconfirmed |

“Unconfirmed” is appropriate when the source does not expose packaging details.

## Compare versions carefully

One version may package subtitles differently or offer another set. Hold device, profile, and source steady while switching versions. Use [the version-change subtitle guide](/blog/how-a-version-change-can-alter-subtitle-availability/) to capture both complete lists.

A missing track after a version switch does not prove that a separate resource failed to load.

## Diagnose a missing separate track

First verify why the track is expected and whether the source owner confirms the association. Record item, version, expected language/role, device, app or browser version, connectivity, and full selector.

Follow [the missing subtitle diagnostic](/blog/how-to-investigate-a-missing-subtitle-track/) without renaming files, moving resources, removing the source, clearing data, or reinstalling unless an authorised source process requires it.

## Understand feature differences

Embedded and separate tracks can both carry useful timed text, while burned-in text cannot be restyled or disabled by a subtitle selector. Actual styling, cue support, and accessibility depend on the resource and player.

The [complete subtitle-management guide](/blog/the-complete-guide-to-managing-subtitle-tracks/) explains language, role, timing, state, and device checks that apply after a track is discovered.

## Protect source rights and privacy

Only use text resources the user owns or is authorised to use. Do not upload media or subtitle files to support unless explicitly authorised and legally appropriate. Reports usually need labels, steps, timestamps, and screenshots—not the content itself.

## Common mistakes and limitations

Avoid calling burned-in text an embedded selectable track, promising automatic matching, assuming every format is supported, and editing source files before preserving evidence.

Packaging can remain opaque when the source exposes only a playable option. Describe observed selector behavior instead of guessing the storage method.

## Frequently asked questions

### Can burned-in subtitles be turned off?

Not as a separate track because the text is part of the image. Another media version may differ, but verify availability.

### Are separate subtitle tracks always text files?

They are separate timed-text resources in this comparison; exact formats and associations depend on the supported source context.

### Does a missing separate track mean the player is broken?

No. Verify association, item/version, source metadata, format support, and the selector before assigning a cause.

## Your next step

[See how Norva works](https://norva.tv/#how-it-works)

## Sources

- [W3C: WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: Making Audio and Video Media Accessible](https://www.w3.org/WAI/media/av/)
- [Norva: How It Works](https://norva.tv/#how-it-works)
