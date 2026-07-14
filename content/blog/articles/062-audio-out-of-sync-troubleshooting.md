---
content_id: "NVB-062"
title: "Audio Out of Sync? Common Causes and Safe Troubleshooting Steps"
seo_title: "Audio Out of Sync: Safe Troubleshooting Steps"
meta_description: "Find out whether lip-sync trouble follows one scene, item, output path, or device before changing advanced audio timing controls."
slug: "audio-out-of-sync-troubleshooting"
canonical_url: "https://norva.tv/blog/audio-out-of-sync-troubleshooting/"
language: "en"
status: "draft"
robots: "noindex,nofollow"

content_type: "troubleshooting"
topic_cluster: "Playback, Languages & Accessibility"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I safely troubleshoot audio that is ahead of or behind the picture?"
supporting_questions: ["How do I identify whether one item or the output path is responsible?", "When should I avoid changing delay settings?"]
audience: ["viewers with lip-sync problems", "TV users", "Norva users"]

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
  source_of_truth: "https://norva.tv/"

published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6

excerpt: "A safe isolation path for lip-sync problems that avoids permanent timing changes before the affected layer is known."
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
parent_pillar: "/blog/choose-audio-track/"
related_articles: ["NVB-053", "NVB-058", "NVB-059"]

cta:
  label: "Report a reproducible sync issue"
  href: "https://norva.tv/support"
  intent: "Escalate with controlled comparison results"

sources:
  - "https://norva.tv/support"
  - "https://html.spec.whatwg.org/multipage/media.html"
  - "https://www.w3.org/TR/media-capabilities/"
proof_assets: []

original_evidence:
  required: true
  status: "present"
  type: "lip-sync isolation sequence"
  summary: "A same-scene comparison across item, audio output, and supported device."
  methodology: "Standards-informed diagnostic; no timing measurement or device-specific correction value is invented."
  asset_urls: []
---

# Audio Out of Sync? Common Causes and Safe Troubleshooting Steps

> **In short:** Replay the same dialogue moment, then compare another item, simplify the audio output path, and test one other supported device. Record whether sound is early, late, constant, or drifting. Do not change permanent delay settings until you know whether the mismatch follows the item, device, external audio equipment, or playback session.

Lip-sync errors are easiest to judge on a close view of a person speaking or a sharp sound with a visible action. A vague impression during music or a wide shot is difficult to reproduce. Begin with one clear reference scene and preserve the current settings.

## Describe the mismatch precisely

Record four details:

- Is audio **ahead of** or **behind** the picture?
- Is the offset roughly constant, or does it grow over time?
- Does seeking away and back change it?
- Does the same moment behave the same way after playback restarts?

This description matters because a constant offset and a drifting offset are different symptoms, even though both feel “out of sync.” Do not estimate milliseconds unless you have a calibrated method.

## Follow the same-scene isolation sequence

This sequence is the original evidence tool for the guide.

### Test 1: Same scene, same setup

Replay the reference moment once. If the mismatch disappears, note that it was intermittent rather than declaring it fixed permanently.

### Test 2: Another item, same setup

Choose another item with clear speech. Keep the device and audio output unchanged. If only the first item is affected, record its exact version and selected audio track.

### Test 3: Simpler output path

If you use an external receiver, soundbar, wireless accessory, or adapter, compare the device’s simplest available audio output according to its official instructions. This removes processing links from the path without assuming which one is responsible.

### Test 4: Another supported device

Use the same account, profile, item, version, and audio track on another supported screen. Record differences in both picture and output path.

| Test | Item | Device | Audio output | Ahead / behind / aligned |
| --- | --- | --- | --- | --- |
| Baseline | A | 1 | Original |  |
| Item comparison | B | 1 | Original |  |
| Output comparison | A | 1 | Simplified |  |
| Device comparison | A | 2 | Device output |  |

## Interpret the pattern

- **One item or track only:** investigate that version or audio track.
- **External path only:** consult the equipment documentation before changing delay controls.
- **One device only:** verify its current software state and supported media capabilities.
- **Every combination:** preserve the table and contact support.
- **Offset grows during playback:** include the elapsed time and when the drift becomes noticeable.

The W3C Media Capabilities specification shows that decoding behaviour depends on the media configuration and device. The WHATWG HTML standard defines timed media playback, but neither source lets a reader diagnose a specific consumer setup from symptoms alone.

## Change timing controls only with a baseline

Some displays or audio devices provide lip-sync or delay controls. Before using them:

1. photograph or write down the original value;
2. confirm that the problem affects more than one item;
3. follow the manufacturer’s instructions;
4. make one small change;
5. replay the same reference scene;
6. restore the baseline if other items become worse.

Never copy another person’s delay value as a universal fix. Processing paths and equipment differ.

If audio language rather than timing is wrong, use [the language-selection repair guide](https://norva.tv/blog/fix-wrong-audio-language/). If the whole player pauses, use the [buffering checklist](https://norva.tv/blog/video-buffering-diagnostic-checklist/). If playback never starts, follow [the start-failure grid](https://norva.tv/blog/video-wont-start-troubleshooting/).

## Common mistakes and limitations

- Judging sync during a scene with no precise visual sound cue.
- Changing permanent delay controls before comparing another item.
- Testing another device with a completely different item and connection.
- Confusing the wrong audio track with a timing problem.
- Reporting “audio lag” without stating whether sound is early or late.
- Claiming an exact offset without a calibrated measurement.

This checklist narrows the affected layer; it cannot prove a codec, source, device, or equipment fault on its own.

## Frequently asked questions

### Can network problems cause audio and picture to separate?

They can contribute to playback disruption, but a lip-sync symptom alone does not prove a network cause. Compare the same scene, another item, and the output path first.

### Should I reset my soundbar or television?

Not before recording the baseline and simplifying the output path. Follow the manufacturer’s instructions if a reset later becomes necessary.

### What evidence should I send to support?

Include whether audio is early or late, whether the offset drifts, the reference timestamp, item and version, audio track, device, output path, and results from the comparison table.

## Your next step

[Report a reproducible sync issue](https://norva.tv/support)

## Sources

- [Norva Support](https://norva.tv/support)
- [WHATWG HTML: Media elements](https://html.spec.whatwg.org/multipage/media.html)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)

