---
content_id: "NVB-582"
title: "Volume and Loudness: Why They Are Not Identical"
seo_title: "Volume vs Loudness: Why They Differ"
meta_description: "See why a volume slider is not a loudness meter. Compare gain, programme loudness, peaks, dynamic range, and output changes without guessing from a number."
slug: "volume-and-loudness-why-they-are-not-identical"
canonical_url: "https://norva.tv/blog/volume-and-loudness-why-they-are-not-identical/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "technical-explainer"
topic_cluster: "Audio Quality Literacy"
search_intent: "volume vs loudness audio"
funnel_stage: "consideration"
primary_question: "What is the difference between volume and loudness in audio playback?"
supporting_questions:
  - "How do gain, programme loudness, peaks, dynamics, spectrum, channels, output, and environment differ?"
  - "How can two tracks be compared without relying on slider position or brief peaks?"
audience:
  - "Viewers comparing audio levels"
  - "Households troubleshooting level jumps"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: "2026-09-10T20:52:12Z"
last_fact_check: "2026-09-10"
estimated_reading_minutes: 7
excerpt: "The same volume setting can produce different listening levels. Separate signal gain, programme loudness, peaks, and your output route with a worked calculation and comparison checklist."
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
parent_pillar: "/blog/the-complete-guide-to-understanding-audio-quality/"
related_articles:
  - "/blog/the-complete-guide-to-understanding-audio-quality/"
  - "/blog/how-to-read-an-audio-track-list-before-playback/"
  - "/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://developer.mozilla.org/en-US/docs/Web/API/GainNode"
  - "https://www.itu.int/rec/R-REC-BS.1770/en"
  - "https://tech.ebu.ch/publications/r128"
  - "https://www.sony.com/electronics/support/televisions-projectors/articles/00203665"
  - "https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "constructed gain calculation and comparison checklist"
  summary: "Two explicitly invented digital sample-peak values are multiplied by the same linear gain, showing different output peaks while leaving programme loudness and acoustic output unknown."
  methodology: "The worked arithmetic illustrates gain rather than reporting a playback test or loudness measurement. A separate reader checklist holds track, excerpt, route, processing, and listening context steady and labels unmeasured quantities as unknown."
  asset_urls: []
---
# Volume and Loudness: Why They Are Not Identical

> **In short:** A volume control changes gain at a point in the playback chain. Loudness is how strong sound seems; programme-loudness measurements estimate it from the audio signal using a defined method. The recording, mix, and processing affect that signal, while the output device and listening environment also affect what you hear. The same slider position does not guarantee the same listening level.

If one film sounds much louder than another without touching the remote, the volume control has not necessarily changed. You may be hearing a different mix, track, or processing mode. Start by separating the control setting from the audio it acts on, rather than treating the displayed number as a measurement of the whole experience.

## Map every gain stage

Gain means scaling the signal at a particular stage. A simple digital gain multiplies each sample by a value; [MDN's GainNode documentation](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) shows that principle. A consumer slider need not expose that multiplier directly, and a setting of “50” is not a universal acoustic level or a guarantee of half the perceived loudness.

Record the controls that actually apply: player volume, operating-system media level, TV or receiver level, headphone controls, and any per-track adjustment. Some controls may be linked, while other stages may be fixed or bypassed for the chosen route. Check which device is producing sound before changing one control at a time.

## Understand programme loudness

[ITU-R BS.1770](https://www.itu.int/rec/R-REC-BS.1770/en) defines algorithms for programme-loudness and true-peak measurement. A programme-loudness reading describes an audio signal under that method; it does not directly measure sound pressure at your ears. The recommendation also notes that measured loudness estimates perception with some uncertainty across listeners, material, and listening conditions.

You may encounter **LUFS**, loudness units referenced to digital full scale. An integrated reading covers the analysed programme or excerpt, whereas shorter-term readings describe a smaller window. State the method, channels, analysed interval, and whether measurement occurred before or after processing. Do not label a short dialogue sample as a whole-film result.

[EBU R 128](https://tech.ebu.ch/publications/r128) uses loudness measurements in a broadcast normalisation framework and distinguishes loudness from maximum true-peak level. It is not a universal target for every consumer app, and it does not turn a volume slider into a meter.

## Separate peaks and dynamic range

Sample peaks describe the largest absolute recorded sample values; true-peak measurement estimates waveform peaks that can occur between samples. Neither number tells you how continuously the programme stays loud. A brief impact and sustained dialogue can reach the same peak while presenting different overall listening levels.

Dynamic range concerns the contrast between quieter and louder material. Raising a fixed volume setting raises both; it does not selectively bring quiet dialogue closer to loud effects. Dynamic-range processing addresses a different problem. For example, [Sony's official guidance](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665) describes settings that alter this contrast on specified TVs and audio formats. That is a device-specific example, not a claim that Norva offers the same setting.

## Original evidence: gain-loudness card

This is a **constructed arithmetic example**, not measured media, a listening test, or a Norva volume setting. Assume two digital signals with the sample peaks below and a simple linear gain of 0.5. The unitless peak values are fractions of digital full scale, not decibels or sound-pressure measurements. No other processing is included.

| Constructed signal | Largest absolute input sample | Gain multiplier | Calculated output sample peak | Programme loudness or level at the ears |
| --- | --- | --- | --- | --- |
| A | 0.20 | 0.5 | 0.20 × 0.5 = 0.10 | Unknown from these values |
| B | 0.60 | 0.5 | 0.60 × 0.5 = 0.30 | Unknown from these values |

The same gain leaves different output peaks because the input signals differ. B's calculated sample peak is three times A's, but that does **not** mean B sounds three times as loud. We have not specified the rest of either signal, its duration, the output equipment, or the listening conditions.

Matching those peaks would still not establish equal programme loudness. This card deliberately stops at what the arithmetic proves; it cannot supply a LUFS reading, a quality ranking, or a safe headphone level. A multiplier of 0.5 also does not imply that a particular product's slider should be set to 50%.

## Compare tracks at matched level

If the question is which track is clearer, avoid making level the uncontrolled difference. Use this small comparison procedure with media you are authorised to play:

1. Identify both track labels and roles. A commentary track is not the same mix as the main soundtrack; use the [audio-track list guide](/blog/how-to-read-an-audio-track-list-before-playback/) if the labels are unclear.
2. Choose the same passage in both versions. Record start and end times, and include dialogue plus a louder moment if that is the problem you are investigating.
3. Keep the device, output route, listening position, and processing state fixed. Record unknown settings instead of assuming they are off.
4. Compare at a low, comfortable level. Reduce the apparently louder track when making a rough perceived-level match; do not raise the quieter one until a loud effect becomes uncomfortable. If using a valid loudness meter, record its method and scope separately.
5. Alternate the order and record a narrow observation, such as “dialogue remains hard to follow after approximate level matching.” Do not convert an informal preference into a measured superiority claim.

An ear-based match is approximate, not a standards-compliance result. If the passage cannot be compared comfortably, stop the comparison.

## Include normalisation

Loudness normalisation adjusts programme or playback gain toward a defined loudness relationship. Peak normalisation instead uses a peak criterion. Neither term, by itself, means that quiet dialogue and loud effects are brought closer together within a programme; that would require a change to their relative levels.

Targets, measurement scope, peak handling, and user controls depend on the implementation. Check the app, TV, receiver, or headphone documentation for any active normalisation or dynamic processing. This article does not establish a Norva normalisation target or claim that Norva applies EBU R 128.

## Include output sensitivity and room

Headphones and speakers can produce different acoustic levels from the same digital signal or displayed setting. Fit, distance, room reflections, background noise, and device processing also affect listening. If you switch outputs, you have changed the comparison even if the number on the screen stays the same.

If quiet detail is masked by room noise, investigate the environment or use appropriate [caption coverage](/blog/captions-and-subtitles-why-the-accessibility-goals-can-differ/) instead of continually increasing volume. [WHO's safe-listening guidance](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening) stresses both sound level and exposure duration and recommends breaks and reducing the need to turn up sound in noisy settings. Comfort alone is not an exposure measurement.

## Report a level difference

Record the item/version, exact track labels, excerpt times, applicable volume controls, processing state, output route and device, room conditions, comparison method, and result. Include valid measurements only when available, with their scope. “No loudness measurement; TV processing unknown” is more useful than an invented decibel estimate from the slider.

[The complete audio-quality guide](/blog/the-complete-guide-to-understanding-audio-quality/) maps the rest of the chain.

## Common mistakes and limitations

Avoid comparing slider numbers across devices, treating peak matching as loudness matching, or using an unvalidated phone sound-level reading as calibrated proof. A phone microphone near a speaker is also not a direct measurement of sound inside headphones. Informal listening is not a formal loudness-compliance test, a hearing assessment, or proof that a codec or player is better.

## Check level after a route change

When switching from speakers to headphones or a receiver, check the destination's level before starting or resuming playback and begin low. Record the active gain stages rather than copying the previous number. If you changed the route and the media at the same time, return to a known passage at a low level before deciding that the new track caused the difference.

## Frequently asked questions

### Is volume the same as programme loudness?

No. The volume control sets gain at a stage in playback. A programme-loudness reading characterises the signal under a specified measurement method; neither alone determines the acoustic level at your ears.

### Does the same slider value produce the same loudness on two devices?

No. Gain structure, amplifier, output sensitivity, speakers or headphones, room, and processing differ.

### Is peak normalisation the same as loudness normalisation?

No. Peak and loudness measurements describe different properties and support different workflows.

## Your next step

Before comparing another version, record the track and output route you actually used. Then [explore Norva's playback features](https://norva.tv/#features) without assuming an undocumented normalisation mode. Norva is media-player software, with no content or TV subscription included; your media must come from a compatible source you are authorised to use.

## Sources

- [MDN: digital gain and the GainNode](https://developer.mozilla.org/en-US/docs/Web/API/GainNode)
- [ITU-R BS.1770: Programme Loudness and True Peak](https://www.itu.int/rec/R-REC-BS.1770/en)
- [EBU R 128: Loudness Normalisation](https://tech.ebu.ch/publications/r128)
- [Sony: dynamic-range settings and applicable formats](https://www.sony.com/electronics/support/televisions-projectors/articles/00203665)
- [WHO: safe listening, level, and exposure duration](https://www.who.int/news-room/questions-and-answers/item/deafness-and-hearing-loss-safe-listening)
- [Norva Features](https://norva.tv/#features)
