---
content_id: "NVB-916"
title: "A Guide Filter Hides Expected Channels: What to Inspect"
seo_title: "Guide Filter Hides Channels? What to Inspect"
meta_description: "Troubleshoot channels hidden by guide filters by checking source scope, group, visible controls, query, profile, time window, device, and small channel samples."
slug: "guide-filter-hides-channels"
canonical_url: "https://norva.tv/blog/guide-filter-hides-channels/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "guide-filter-troubleshooting"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot channels hidden by guide filters?"
supporting_questions:
  - "Which source, group, control, query, profile, guide-window, channel-sample, device, and timing evidence should be recorded?"
  - "How can hidden rows be separated from missing source or schedule data?"
audience:
  - "Norva users missing expected channels after filtering"
  - "Households using guide groups and search"
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
excerpt: "A hidden-channel check records source and group scope, every visible filter and query, active profile, guide window, representative channels, device context, and before-and-after state."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/tv-guide-grid-empty/"
  - "/blog/guide-search-no-results/"
  - "/blog/guide-works-on-one-device-only/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Review Filter Support"
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
  type: "guide filter state matrix"
  summary: "A matrix records account and profile, source and channel group, every visible guide filter and search query, selected date and window, expected channel identities, source presence, before-and-after row counts, device and application version, timestamp, and one-variable tests."
  methodology: "The user captures the complete baseline, removes one visible restriction, checks expected and control channels, restores baseline between tests, compares another supported device, and avoids deleting groups or resetting data."
  asset_urls: []
---

# A Guide Filter Hides Expected Channels: What to Inspect

> **In short:** Capture the full filter state before changing anything: active profile, authorized source, channel group, favorites or availability view, search query, selected date, guide window, and every visible control. Choose two expected channels and one control, confirm source presence, then remove one restriction at a time and restore baseline. Record row counts, device, application version, and timestamps. Do not delete groups or reset data to clear an unknown filter.

A hidden channel is different from a missing channel. The row may return when source scope, group, favorites, search, or another visible control changes, while its schedule data remains intact. Start with one known channel so each comparison remains easy to explain.

## Preserve the complete baseline

Record account, profile, source selection, channel group, favorites-only or availability view, category, language, search query, selected date, guide window, sorting, and every active chip, toggle, or badge that visibly affects scope.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the full context matrix.

## Select expected and control channels

Choose two expected channels and one visible control. Record privacy-safe names, source and visible identifiers, group membership where shown, and row state. Avoid exporting the entire channel lineup.

## Confirm source presence

Through the provider's official authorized route, verify each expected channel currently exists and record source identity cues. If it is absent from the source, classify that before testing Norva filters.

## Remove one restriction

Change one visible filter, group, source selection, favorites view, or search query. Record the new row count and whether each sample appears. Restore the original state before changing another control.

If clearing a query changes the result, use the [guide search matrix](/blog/guide-search-no-results/) to document exact text and scope.

## Check nested scope

Record parent section, media or channel category, sub-group, and navigation path. A channel may be outside the selected group rather than hidden by an individual filter. Do not assume group membership rules that are not visible.

## Check profile context

Verify the active profile on every observation. A different profile can carry a different view or favorite state. Do not describe the result as account-wide without comparing profiles deliberately and privately.

## Verify guide window separately

A channel row can be visible while listings are absent for the selected date or time. Keep channel visibility and schedule coverage separate. The [empty-grid guide](/blog/tv-guide-grid-empty/) handles rows without program cells.

## Compare another supported device

Use the same account, profile, source, group, filters, query, date, window, and close timestamp. Record both application versions. The [cross-screen guide check](/blog/guide-works-on-one-device-only/) helps identify a device-specific view difference.

## Record focus and control state

On TV, note which control has visible focus, whether its state can be read, and whether pressing the documented confirmation control changes it. Do not assume a filter changed if focus moved but state did not.

## Avoid “clear everything” shortcuts

Do not delete channel groups, unfavorite channels in bulk, remove the source, clear application data, reinstall, or reset the device before saving the matrix. Broad cleanup destroys the exact state that explains the hidden row.

## Classify the result

Use source absent, outside selected source or group, favorites-state difference, search query restriction, another visible filter, profile difference, guide-window-only issue, device-specific filter state, focus did not activate control, or unknown.

## Prepare support evidence

Use the [guide evidence template](/blog/guide-issue-support-evidence/) with baseline controls, channel samples, one-variable results, row counts, profile, devices, versions, and timestamps. Redact private channel names when possible.

## Original evidence: filter state matrix

| Test | Changed control | Expected A | Expected B | Control | Row count |
| --- | --- | --- | --- | --- | --- |
| Baseline | None |  |  |  |  |
| 1 |  |  |  |  |  |
| 2 |  |  |  |  |  |
| Other device | Device only |  |  |  |  |

## Common mistakes and limitations

- Changing several filters at once.
- Ignoring profile, group, favorites, or search state.
- Treating empty schedule cells as hidden channel rows.
- Clearing all settings before preserving baseline.
- Assuming focus movement changed a control.
- Sharing a complete private channel list.

## Frequently asked questions

### Should I use a clear-all control?

Only after recording the baseline and if current Norva guidance documents the control. One-variable tests provide clearer evidence.

### Does finding the channel in search prove the group is wrong?

It proves the channel is visible in another context, not why its group or filter membership differs.

### What if only one profile hides it?

Record the profile-specific state without exposing other household data and avoid calling the result account-wide.

## Your next step

[Review Filter Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
