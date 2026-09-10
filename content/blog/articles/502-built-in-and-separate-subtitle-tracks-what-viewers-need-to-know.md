---
content_id: "NVB-502"
title: "Built-In and Separate Subtitle Tracks: What Viewers Need to Know"
seo_title: "Embedded vs External vs Burned-In Subtitles Explained"
meta_description: "Compare embedded subtitle tracks, external subtitle files, and burned-in text. Learn what a container, track selector, and off switch can actually tell you."
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/support"
published_at: null
updated_at: "2026-09-10T20:52:12Z"
last_fact_check: "2026-09-10"
estimated_reading_minutes: 7
excerpt: "An embedded track is not burned-in text. Compare subtitle packaging through a completed example, then separate what the selector proves from what remains unknown."
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
  - "/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/"
  - "/blog/legibility-and-readability-two-different-viewing-problems/"
cta:
  label: "Ask Norva Support About Your Subtitle Setup"
  href: "https://norva.tv/support"
  intent: "consideration"
sources:
  - "https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers"
  - "https://www.matroska.org/technical/subtitles.html"
  - "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track"
  - "https://www.w3.org/TR/webvtt1/"
  - "https://www.w3.org/WAI/media/av/captions/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "illustrative subtitle packaging identification card"
  summary: "A completed fictional packaging card compares an embedded MKV track, an external WebVTT resource, burned-in text, and a selectable track of unknown origin."
  methodology: "Author-defined packaging facts are separated from expected control behaviour. The example is not a Norva playback test; real packaging is confirmed only with source information, not appearance or an off switch alone."
  asset_urls: []
---
# Built-In and Separate Subtitle Tracks: What Viewers Need to Know

> **In short:** Embedded subtitle data is stored inside the media container; external subtitles are stored separately and associated with the media. Either can become a selectable track when supported. Burned-in subtitles are already part of the video picture and cannot be switched off as a track. A working subtitle selector proves a control works, not where the subtitle data is stored.

“Built-in” is often used for both an embedded track and text permanently rendered into the image. That ambiguity matters: one may be selectable, while the other is part of the picture itself. Start with how the media is packaged, then check what this player exposes for the selected version.

## Define the three practical categories

- **Embedded selectable track:** subtitle data packaged inside the media container, separate from its video images, and exposed as a choice when supported.
- **Separate associated track:** subtitle data stored apart from the media and linked through the source or playback context. A separate file is sometimes called a sidecar file.
- **Burned-in text:** pixels already present in the video image; no selector can turn them off independently.

A **container**, such as MKV or MP4, packages media streams and metadata. It is not itself a subtitle track or a guarantee of decoder support. [MDN's container guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers) separates the container from the codecs inside it. An MKV extension alone therefore tells you neither which subtitles exist nor whether a particular player will expose them.

Subtitle data is not always plain text. The [Matroska subtitle specification](https://www.matroska.org/technical/subtitles.html) describes text-based subtitles and image-based formats such as VobSub. An image-based subtitle track is still separate from the video picture; “image-based” does not mean “burned in.” These categories describe packaging, not translation quality or accessibility completeness.

## Identify the category through behavior

Open the subtitle selector for the exact item and version and record the entries before changing anything. Choose one track, note its label, and inspect a scene containing a cue. If an off control is available, use it and revisit the same moment; comparing two different moments may merely compare a cue with a subtitle-free pause.

If the selected text disappears, that establishes that it was controllable in this context. It does **not** distinguish an embedded track from an external one. If text remains, burned-in text is one possibility, but check for another active caption layer or device-level caption feature before concluding that it is part of the video. Confirm storage through information about the supplied media, not visual style alone.

## Treat separate-track support as conditional

A separate resource needs an association with the right item and a format the playback context supports. The [HTML track element](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track), for example, explicitly points to an external resource and can supply a language and label. The [WebVTT draft specification](https://www.w3.org/TR/webvtt1/) defines a timed-text format used for that purpose. This is a web-platform example, not a description of Norva's import controls.

A file sitting beside a video is not automatically associated with it in every player. Check the documented workflow for the device and source you are using. The existence of external subtitle tracks does not, by itself, establish arbitrary local-file import, automatic filename matching, or universal format support in Norva.

## Original evidence: packaging card

This **authored illustration** uses a fictional clip, Harbour Gate, with the line “The gate is open” at 00:18. There are no downloadable sample files and no Norva playback observations. Rows A–C define different ways an owner could prepare that clip; the control behaviour assumes a player supports the specified resource.

| Version | Packaging information supplied in the example | Expected control behaviour | Justified conclusion |
| --- | --- | --- | --- |
| A | An MKV container contains video, audio, and a separate English subtitle track inside it | Selecting English shows the cue; switching that track off hides it | Embedded subtitle track, because its storage is explicitly known |
| B | An MP4 video is explicitly associated with a separate English WebVTT file containing the cue | Selecting English shows the cue; switching it off hides it | External subtitle resource, because the association and separate storage are known |
| C | The owner rendered the English line into the video images; no subtitle track is supplied | A subtitle off control cannot remove those pixels | Burned-in text, because the supplied video is defined that way |
| D | Only a player entry labelled English is known; it can show and hide the cue | The toggle works, as with A and B | Selectable subtitle track; embedded or external storage remains unconfirmed |

Rows A and B can look identical in the player. Row D is the important boundary: an off-switch test cannot tell them apart. A real item can also combine burned-in text with a selectable translation, so more than one category may apply to different visible lines.

To reuse the card, record the item/version, complete selector list, selected label, cue time, off-state result, and the source of any packaging information. Write “unconfirmed” wherever the media source does not expose enough detail.

## Compare versions carefully

One version may package subtitles differently or offer another set. Keep the device, profile, and media source fixed while comparing versions, and capture each complete track list. Verify the edition and duration as well as the title: a subtitle resource timed for another cut may not align with the same named film.

A missing track after a version switch does not prove that a separate resource failed to load.

## Diagnose a missing separate track

First establish why you expect that track. A catalogue label, a file supplied by the owner, and a track actually listed for this version are different kinds of evidence. Ask whether the source owner confirms the resource and its association with the selected version.

Record the expected language and role, device, app or browser version, connectivity, and complete selector. Separate “not listed,” “listed but cannot be selected,” and “selected but no cue visible at the checked moment.” Those observations point to different questions; none alone proves a player defect. Preserve this evidence before renaming files, moving resources, removing the source, clearing data, or reinstalling.

## Understand feature differences

Embedded and external tracks can both provide useful subtitles. Styling options depend on the format and renderer; text-based and image-based resources need not offer the same controls. Burned-in text cannot be independently restyled or disabled through a subtitle selector. W3C's [caption guidance](https://www.w3.org/WAI/media/av/captions/) likewise distinguishes captions that viewers can hide from open captions that remain displayed.

The [complete subtitle-management guide](/blog/the-complete-guide-to-managing-subtitle-tracks/) explains language, role, timing, state, and device checks that apply after a track is discovered.

Then assess what the track contains: [captions and dialogue subtitles can meet different information needs](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/). If cues are present but hard to read, separate [legibility from readability](/blog/legibility-and-readability-two-different-viewing-problems/) instead of blaming the storage method.

## Protect source rights and privacy

Use media and subtitle resources you own or are authorised to access. Norva is a media player, with no content or TV subscription included; connecting a resource does not grant rights to it. Do not upload media or subtitle files to support without the necessary permission. Start a report with non-sensitive labels, steps, and timestamps; review screenshots for private source addresses or account details before sharing them.

## Common mistakes and limitations

Avoid calling burned-in text an embedded selectable track, promising automatic matching, assuming every format is supported, and editing source files before preserving evidence.

Packaging can remain opaque when the source exposes only a playable option. Describe observed selector behaviour instead of guessing the storage method.

## Frequently asked questions

### Can burned-in subtitles be turned off?

Not as a separate track because the text is part of the image. Another media version may differ, but verify availability.

### Are separate subtitle tracks always text files?

No. WebVTT and SubRip are text-based examples, but subtitle resources can also be image-based, as with VobSub. “Separate” describes where the resource is stored relative to the media, not how its cues are encoded. Check the actual format and documented support.

### Does a missing separate track mean the player is broken?

No. Verify association, item/version, source metadata, format support, and the selector before assigning a cause.

## Your next step

If the source confirms a subtitle resource but the result remains unclear, bring your completed packaging card to [Norva support](https://norva.tv/support). State what you observed and what is still unconfirmed; leave media files and private connection details out of the initial report.

## Sources

- [MDN: media containers and the codecs they contain](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)
- [Matroska: subtitle codecs, including text and image-based tracks](https://www.matroska.org/technical/subtitles.html)
- [MDN: the HTML track element and external resources](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track)
- [W3C: WebVTT draft specification](https://www.w3.org/TR/webvtt1/)
- [W3C: captions, subtitles, and open or closed presentation](https://www.w3.org/WAI/media/av/captions/)
- [Norva: features and compatible-source requirements](https://norva.tv/#features)
