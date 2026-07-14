---
content_id: "NVB-059"
title: "Video Won’t Start? How to Separate Source, Network, and Device Issues"
seo_title: "Video Won’t Start? Isolate Source, Network, and Device"
meta_description: "Use a small comparison grid to determine whether failed playback follows one item, one device, one connection, or the wider account context."
slug: "video-wont-start-troubleshooting"
canonical_url: "https://norva.tv/blog/video-wont-start-troubleshooting/"
language: "en"
status: "draft"
robots: "noindex,nofollow"

content_type: "troubleshooting"
topic_cluster: "Playback, Languages & Accessibility"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I determine why a video will not start?"
supporting_questions: ["How do I distinguish an item problem from a device problem?", "What evidence should I collect for support?"]
audience: ["viewers with failed playback", "Norva users", "home-network users"]

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
estimated_reading_minutes: 7

excerpt: "A comparison-based diagnostic that separates item, source, network, account, and device leads when playback never begins."
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
related_articles: ["NVB-058", "NVB-061", "NVB-065"]

cta:
  label: "Send the evidence to Norva Support"
  href: "https://norva.tv/support"
  intent: "Escalate a reproducible start failure"

sources:
  - "https://norva.tv/support"
  - "https://html.spec.whatwg.org/multipage/media.html"
  - "https://www.w3.org/TR/media-capabilities/"
proof_assets: []

original_evidence:
  required: true
  status: "present"
  type: "two-by-two playback isolation grid"
  summary: "A comparison grid crossing two items and two devices while holding profile and connection context steady."
  methodology: "Standards-informed troubleshooting framework; no unsupported cause is inferred from a single failed attempt."
  asset_urls: []
---

# Video Won’t Start? How to Separate Source, Network, and Device Issues

> **In short:** Capture the exact error, then compare two items on the same device and the original item on one other supported device. Keep the account, profile, and connection context as stable as possible. The pattern reveals whether the strongest lead follows one item, one device, the connection path, or every tested combination.

A player that never leaves the loading state presents a different symptom from playback that starts and later pauses. Do not apply a buffering checklist blindly. First determine whether the failure is local to one catalog entry or broad enough to affect other items and screens.

## Preserve the first failure

Before retrying, record:

- the exact item and grouped version;
- active account profile;
- device type and app surface;
- connection method;
- local date and time;
- every visible error message;
- whether artwork and item details loaded normally;
- whether playback showed a frame, sound, or no media at all.

This evidence can distinguish “the control responded but media did not start” from “the interface itself stopped responding.”

## Run a two-by-two isolation grid

The grid below is the original evidence element for this article. Choose item A, which fails, and item B, a different item exposed by the same authorised source. Use device 1, then one other supported device if available.

| Test | Item | Device | Result |
| --- | --- | --- | --- |
| 1 | A | 1 |  |
| 2 | B | 1 |  |
| 3 | A | 2 |  |
| 4 | B | 2 |  |

Keep the profile and connection context stable where possible. If device 2 uses another connection, note that clearly because two variables changed.

## Read the pattern without overclaiming

- **Only item A fails everywhere:** focus on that item, version, or source path.
- **Both items fail only on device 1:** focus on device state or its support for the media configurations.
- **Everything fails on both devices:** check account context, source availability, and the shared connection path.
- **Results vary by both item and device:** preserve the grid and escalate; the interaction may need deeper investigation.

The W3C Media Capabilities specification recognises that support and expected smoothness can depend on codec, profile, resolution, bitrate, frame rate, and output capabilities. This does not identify the specific cause of your failure, but it explains why “the device plays other video” is not a universal compatibility test.

## Add a network comparison only when needed

If the grid implicates every item on one connection path, compare another stable path if available and affordable. Keep the device and item unchanged. Avoid unexpected mobile-data use.

If playback begins but then repeatedly pauses, switch to the [buffering diagnostic checklist](https://norva.tv/blog/video-buffering-diagnostic-checklist/). For a broader explanation, [network speed versus stability](https://norva.tv/blog/network-speed-vs-stability-video/) separates capacity from loss and delay variation.

## Check the exact item context

Norva can organise a source and group versions. Similar artwork does not guarantee identical underlying media. Reopen details and verify that you tested the intended version. If another version exists, compare it while keeping device and connection unchanged.

Do not assume the player can repair media that the authorised source does not currently expose or deliver. Norva’s subscription covers the software experience, not the media access itself.

## Safe device checks

After the grid points to one device:

1. close unrelated heavy applications or browser tabs;
2. confirm the device and app are in a normal, updated state using their official controls;
3. retry the same item once;
4. record whether another known item starts;
5. avoid clearing all data until account and source details are safely recorded.

Do not claim a specific hardware requirement without checking the device and media documentation. The article on [what determines video quality](https://norva.tv/blog/what-determines-video-quality/) explains why resolution alone is insufficient.

## Common mistakes and limitations

- Retrying without recording the first error loses valuable evidence.
- Comparing different items on different networks changes too many variables.
- Assuming every grouped version has identical media characteristics is unsafe.
- Treating a browser, phone, and TV as having the same decoding support ignores real device differences.
- Reinstalling before completing the grid can remove useful context.

This process identifies the layer that deserves attention; it does not prove the root cause. Source delivery, media configuration, network conditions, account context, and device capabilities can interact.

## Frequently asked questions

### What if no other item is available for comparison?

Record that limitation. Compare the same item on another supported device or at another time, changing only one factor per attempt.

### Does a black screen prove the video format is unsupported?

No. A black screen can have several causes. Record whether audio plays, whether an error appears, and how another item behaves before drawing a conclusion.

### Should I reset the device first?

No. Capture the error and complete the smallest useful comparison first. A reset can change the symptom without showing what caused it.

### What belongs in a support request?

Include the grid, device types, profile, exact items and versions, connection context, local time, and exact error text. Exclude passwords, source credentials, and private links.

## Your next step

[Send the evidence to Norva Support](https://norva.tv/support)

## Sources

- [Norva Support](https://norva.tv/support)
- [WHATWG HTML: Media elements](https://html.spec.whatwg.org/multipage/media.html)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)

