---
content_id: "NVB-863"
title: "Catalog Import Stuck at the Same Stage? Build a Timeline"
seo_title: "Catalog Import Stuck? Build a Timeline"
meta_description: "Diagnose an import at one displayed stage by recording start and change times, visible labels and counts, source state, device context, and observations."
slug: "catalog-import-stuck-same-stage"
canonical_url: "https://norva.tv/blog/catalog-import-stuck-same-stage/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "stalled-import-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose an import that remains at one displayed stage?"
supporting_questions:
  - "Which stage labels, timestamps, counts, source, device, and network facts create a useful timeline?"
  - "When should the state be escalated without inventing a timeout?"
audience:
  - "Norva users observing an unchanged import stage"
  - "Household source administrators"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "An unchanged-stage investigation records what the interface displays, when it began, when it last changed, and which source, device, network, and count signals remained stable."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/catalog-import-will-not-start/"
  - "/blog/delayed-sync-after-source-update/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "unchanged import stage timeline"
  summary: "A timeline records request time, first stage, each visible change, last change, current label, displayed count, device and application context, source observation, network state, and user actions."
  methodology: "The user observes at recorded intervals, preserves unchanged as a valid result, avoids repeated requests, compares only stable contexts, and escalates based on current official guidance rather than an invented deadline."
  asset_urls: []
---

# Catalog Import Stuck at the Same Stage? Build a Timeline

> **In short:** Record when the request began, every displayed stage or message, the last visible change, any count or progress cue, device and application version, network, account, profile, and authorized source state. Observe without repeatedly restarting. Call the stage unchanged for the documented interval, not universally stalled. Use current Norva guidance for timing, perform only one controlled comparison, and escalate a redacted timeline.

A screen that appears unchanged is an important observation, but it does not reveal whether work continues, waits on another layer, or has stopped. A timeline gives support evidence without inventing internal behavior.

## Capture the exact stage

Copy the visible label, message, percentage, count, animation state, and enabled or disabled controls. Record whether the page remains responsive. A screenshot can help if it excludes credentials, private addresses, and unnecessary catalog titles.

If no acknowledgment ever appeared, use the [import-start checklist](/blog/catalog-import-will-not-start/) instead.

## Establish three timestamps

Record the initial request, the first appearance of the current stage, and the last observed change. Add timezone and device-local clock. If you did not watch continuously, state the observation gaps. “Unchanged between 14:10 and 14:35” is stronger than “stuck forever.”

Do not claim a timeout unless current official guidance defines one.

## Record count movement separately

A stage label may remain the same while a displayed count changes, or a count may remain static while another cue changes. Log each signal independently. Do not estimate precise progress from an animation or infer unseen catalog work from device heat, fan noise, or network activity.

## Check the authorized source layer

Through the provider's official route, record whether the source responds and whether account access remains authorized. Note maintenance or access messages. Do not change credentials simply because the Norva stage is unchanged.

The [source-timeout guide](/blog/source-connection-timeout-triage/) applies when the source itself fails to respond.

## Freeze account and display context

Keep the Norva account, profile, device, application version, source label, filters, grouping, and network stable. Record foreground and background transitions or device sleep because they alter the observation context, not because they prove a cause.

Avoid reinstalling, clearing data, or removing the source before preserving the timeline.

## Observe at useful intervals

Choose a practical interval that records changes without creating dozens of identical screenshots. Current Norva support guidance should govern any published wait period. If none is stated, report elapsed time only. The purpose is to show when signals changed, not to manufacture a threshold.

## Perform one controlled comparison

When safe and relevant, check the same account and profile on another supported trusted device or network. Label the new timestamp, version, and context. Do not launch another import merely to compare screens. A different display can indicate device-local state, but it does not by itself identify the root cause.

For a source update followed by delayed results, use the [delayed-sync record](/blog/delayed-sync-after-source-update/).

## Stop actions that muddy evidence

Repeated requests, source removal and re-addition, credential rotation, filter changes, application-data clearing, and bulk catalog actions can reset the visible sequence or create new symptoms. If one was already performed, record it honestly in the timeline.

## Build the support packet

Include the exact stage, three timestamps, every visible change, aggregate counts, account and profile context, device and application version, network type, masked source label, source observation, and actions taken. Redact household titles unless a tiny sample is necessary.

The [full troubleshooting handbook](/blog/catalog-import-sync-troubleshooting-handbook/) provides the evidence-layer matrix.

## Original evidence: unchanged import stage timeline

| Time and timezone | Stage or message | Count or cue | Context change | Action |
| --- | --- | --- | --- | --- |
| Request |  |  | Baseline |  |
| First current stage |  |  |  |  |
| Last visible change |  |  |  |  |
| Observation 1 |  |  |  | None |
| Observation 2 |  |  |  | None |
| Controlled comparison |  |  | Device or network |  |

## Common mistakes and limitations

- Calling a stage stalled without a documented interval.
- Restarting before recording the original sequence.
- Combining label, count, and animation into one assumption.
- Changing account, profile, filters, or grouping during observation.
- Treating another device's display as proof of an internal cause.
- Sending private catalog or credential data with the timeline.

## Frequently asked questions

### When is an unchanged stage officially stuck?

Use a current threshold only if Norva publishes one. Otherwise report the exact elapsed interval and visible state to support.

### Should I leave the screen open?

Follow current Norva and device guidance. Record foreground, background, sleep, or navigation changes so the timeline remains interpretable.

### Can I restart once to test it?

Preserve the original timeline first and restart only when current support guidance calls for it. Label any restart as a new sequence.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
