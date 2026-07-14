---
content_id: "NVB-384"
title: "How to Handle Calls and Notifications During Viewing"
seo_title: "Handle Mobile Viewing Interruptions"
meta_description: "Prepare for calls and notifications during mobile viewing, preserve urgent exceptions, then verify playback, audio, subtitles, and settings afterward."
slug: "handle-calls-and-notifications"
canonical_url: "https://norva.tv/blog/handle-calls-and-notifications/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to guide"
topic_cluster: "Mobile Viewing Workflows"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should calls and notifications be handled during mobile viewing?"
supporting_questions:
  - "How can interruptions be reduced without hiding important contacts or alarms?"
  - "What playback state should be rechecked after a call or notification?"
audience:
  - "People managing mobile viewing interruptions"
  - "Norva users preparing focused but reachable sessions"
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
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A deliberate interruption plan covering allowed contacts, alarms, visual alerts, calls, audio focus, post-interruption checks, and setting restoration."
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
parent_pillar: "/blog/mobile-viewing-workflow-guide/"
related_articles:
  - "/blog/return-after-app-backgrounding/"
  - "/blog/one-minute-mobile-session-prep/"
  - "/blog/verify-headphone-audio-route/"
cta:
  label: "Preview Norva's Mobile Experience"
  href: "https://norva.tv/#product-preview"
  intent: "consideration"
sources:
  - "https://support.google.com/android/answer/9069335"
  - "https://support.apple.com/guide/iphone/iphd6288a67f/ios"
  - "https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions"
  - "https://developer.android.com/media/optimize/audio-focus"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "mobile interruption response card"
  summary: "A before-during-after card distinguishes notification suppression, allowed exceptions, call handling, audio-focus changes, playback verification, and restoration."
  methodology: "Reviewers configure a temporary supported notification mode, trigger one harmless test notification and one authorized test call, then record the visible playback and audio state before restoring settings."
  asset_urls: []
---

# How to Handle Calls and Notifications During Viewing

> **In short:** Decide what must remain reachable before viewing, use the device's supported interruption controls with explicit exceptions, and expect a call or alert to change audio or playback state. Afterward, verify position, play state, output, audio track, and subtitles before continuing.

An interruption plan should reduce distraction without making the phone unsafe or unreachable. Blanket silence is easy; a deliberate setup is better. Operating-system version, device maker, organization policy, and app behavior can all change what a notification or call does.

## Classify what may interrupt the session

Create three groups before enabling any mode:

- **Must reach you:** emergency contacts, caregiving calls, essential work contacts, alarms, or critical system alerts.
- **May wait:** routine messages, social updates, promotions, and non-urgent app notifications.
- **Needs a visible but quiet cue:** an item you must notice without hearing it immediately.

This classification matters because Android and Apple both allow supported modes to silence or permit selected people and apps, but exact controls vary. Do not copy another person's settings without checking your own obligations.

## Configure a temporary supported mode

On current Android versions, Modes or Do Not Disturb can manage notification filters; Google cautions that settings differ by phone. On iPhone, Focus can silence notifications temporarily or allow selected contacts and apps. Use official device guidance for the installed version.

Review people, apps, alarms, repeated callers, time limits, and whether silenced notifications remain visible. Prefer a mode that ends automatically at the expected session time, if that option is available and suitable. Take a screenshot of non-sensitive configuration only if you need a recovery reference.

Add this step to the [one-minute mobile preflight](/blog/one-minute-mobile-session-prep/) rather than changing rules after playback begins.

## Understand what a call can change

Apple's audio documentation describes interruptions as a normal part of the platform experience and notes that playback audio can pause for a call. Android audio-focus guidance explains how apps coordinate competing audio. The exact visible outcome still depends on the player and system.

A call can pause playback, reduce volume, move audio focus, display another interface, route sound to a different device, or leave a manual resume step. Declining and answering can produce different transitions. Never assume the content continued or stopped solely from elapsed clock time.

## Respond during an interruption

If a call must be answered, note the approximate playback position only when safe. Avoid tapping repeatedly while the call interface is appearing; queued taps can activate an unintended control. Handle the call, then return through the normal app-switching interface.

For a banner notification, read only what is necessary. Opening it may background the viewing app, while dismissing it may leave playback unchanged. If the notification contains sensitive information, consider what is visible to nearby people or external displays.

## Run the six-point return check

After any meaningful interruption, verify these items in order:

1. **Identity:** the intended title, edition, season, or episode.
2. **Position:** compare the timeline with the last known point.
3. **Play state:** paused, playing, buffering, or ended.
4. **Output:** speaker, headphones, hearing device, vehicle, or another route.
5. **Audio track:** intended available language or descriptive track.
6. **Subtitles:** intended available track, timing, and visibility.

The sequence prevents raising volume when the sound has moved to a speaker. If the app fully left the foreground, follow the deeper [background-return workflow](/blog/return-after-app-backgrounding/).

## Protect audio privacy after a call

Headphones that support multiple devices may switch toward the call and not return as expected. A vehicle system can also retain the route. Before resuming, keep volume low and replay a short sample. The [headphone route verification guide](/blog/verify-headphone-audio-route/) explains how to isolate the destination without changing several settings at once.

Do not use maximum volume as a diagnostic. It increases the risk of sudden sound if the route reconnects.

## Restore the normal notification state

When the session ends, turn off the temporary mode or confirm its scheduled end. Review missed alerts through the operating system rather than depending on memory. Restore any visual, vibration, or sound setting changed specifically for viewing.

If a priority contact failed to reach you during a test, correct that configuration before relying on the mode again. If a supposedly silenced app continued to interrupt, review its permission and exception path using official device instructions.

## Troubleshoot one layer at a time

If playback fails to recover, first confirm network and app foreground state. Then check output, tracks, and position. Restarting immediately can erase useful evidence about the transition. Record device model, operating-system version, app version, interruption type, and observed result before escalation.

## Common mistakes and limits

- Silencing all alerts without preserving urgent exceptions.
- Forgetting that alarms and media can have separate rules.
- Tapping through a call transition too quickly.
- Resuming before checking whether audio moved to a speaker.
- Assuming every notification backgrounds the app.
- Leaving a temporary Focus or Mode enabled after viewing.
- Treating one device's behavior as universal.

## Frequently asked questions

### Will Do Not Disturb stop every call?

Not necessarily. Allowed people, repeated-caller rules, critical alerts, device version, and policy can change the result. Review the active configuration.

### Should playback resume automatically after a call?

It may or may not. Platform and app behavior vary, so verify the play state and position rather than relying on an expectation.

### What should I check first if audio is missing afterward?

Pause, lower volume, and identify the current output route. Then verify play state and the selected audio track.

## Your next step

[Preview Norva's Mobile Experience](https://norva.tv/#product-preview)

## Sources

- [Android Help: Limit Interruptions With Modes and Do Not Disturb](https://support.google.com/android/answer/9069335)
- [Apple iPhone User Guide: Set Up a Focus](https://support.apple.com/guide/iphone/iphd6288a67f/ios)
- [Apple Developer: Handling Audio Interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)
- [Android Developers: Manage Audio Focus](https://developer.android.com/media/optimize/audio-focus)
- [Norva Support](https://norva.tv/support)
