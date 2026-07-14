---
content_id: "NVB-920"
title: "Verify TV Guide Recovery After a Fix"
seo_title: "Verify TV Guide Recovery After a Fix"
meta_description: "Audit guide recovery by retesting the original symptom, schedules, channel identity, time context, filters, focus, layout, performance, and a second device."
slug: "guide-recovery-verification-audit"
canonical_url: "https://norva.tv/blog/guide-recovery-verification-audit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "post-recovery-guide-audit"
topic_cluster: "TV Guide Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I audit television guide behavior after recovery?"
supporting_questions:
  - "Which original symptom, source, channel, time, filter, focus, layout, performance, device, security, and record checks belong in the audit?"
  - "How can recovery be scoped without claiming every guide state is correct?"
audience:
  - "Norva users after resolving a guide issue"
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
excerpt: "A post-recovery guide audit retests the original symptom, then samples source schedules, identity, time, filters, navigation, layout, performance, devices, security, and evidence cleanup."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/tv-guide-troubleshooting-handbook/"
related_articles:
  - "/blog/tv-guide-troubleshooting-handbook/"
  - "/blog/tv-guide-grid-empty/"
  - "/blog/now-next-information-stale/"
  - "/blog/wrong-program-mapped-channel/"
  - "/blog/tv-guide-focus-stuck/"
  - "/blog/tv-guide-scroll-performance/"
  - "/blog/guide-issue-support-evidence/"
cta:
  label: "Confirm With Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.nist.gov/privacy-framework"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "post-recovery guide verification scorecard"
  summary: "A scorecard records the original symptom and fix, stable context, source schedule and channel samples, device clock and zone, filters, search, focus path, layout, short scroll path, second-device result, unresolved differences, security check, evidence retention, owner, and outcome."
  methodology: "The user recreates the baseline, verifies the original symptom first, tests adjacent guide layers with minimal samples, compares another supported device, labels pass, expected difference, unresolved, unknown, or not applicable, and assigns follow-up."
  asset_urls: []
---

# Verify TV Guide Recovery After a Fix

> **In short:** Recreate the original account, profile, source, channel group, filters, guide window, clock, zone, device, and application version, then retest the exact symptom. Add minimal checks for source schedule, channel identity, now-and-next, time alignment, search, filters, remote focus, layout, short scrolling path, and another supported device. Mark pass, expected difference, unresolved, unknown, or not applicable, and assign every unresolved result.

A fix proves that one observed path changed. It does not prove every channel, time window, device, metadata field, and remote-navigation route is correct. A scoped scorecard closes the incident without overstating recovery.

## Record the fix and baseline

Write the original symptom, authorized recovery action, actor, timestamp, device, application version, source context, and first successful result. Keep the suspected cause separate from verified observations.

The [TV guide handbook](/blog/tv-guide-troubleshooting-handbook/) provides the original layer matrix.

## Retest the exact symptom

Use the same channel sample, date, guide window, filters, focus path, or layout view that reproduced the issue. Record before and recovered evidence. If the baseline cannot be recreated, mark the verification limited.

## Verify source schedule and identity

For one affected channel and one control, confirm source presence, visible identifiers, current and next program cues, and start/end times. Do not export the channel lineup.

If the incident involved mapping, reuse the [channel-program crosswalk](/blog/wrong-program-mapped-channel/).

## Verify time context

Record device clock, named zone, UTC offset where visible, automatic or manual state, selected date, guide window, and time marker. Confirm the recovered view across at least two listing boundaries when time was the original symptom.

## Verify data completeness

Check channel rows, current and next listings, one episode field sample, and one description cue. Use the [empty-grid checklist](/blog/tv-guide-grid-empty/) and [now-and-next timeline](/blog/now-next-information-stale/) only for relevant branches.

## Verify filters and search

Record source, group, favorites or availability view, filters, and one distinctive search query. Confirm expected channels appear when the baseline scope is restored. Do not clear household favorites to make the audit pass.

## Verify remote focus

Run a three-step documented path from a known element. Record visible focus, expected and actual target, boundary, overlay, and scroll. Use the [focus trace](/blog/tv-guide-focus-stuck/) for any unresolved movement.

## Verify layout and scrolling

Check one formerly overlapping row and repeat one short scroll path under stable conditions. Record first and repeat observations without inventing speed targets. The [scroll sheet](/blog/tv-guide-scroll-performance/) handles residual pauses.

## Compare another supported device

Use the same account, profile, source, group, filters, guide window, and close timestamp. Record device clocks, zones, operating systems, and application versions. Recovery on one screen does not establish recovery everywhere.

## Confirm stability after a short interval

Repeat the original path after a short, recorded interval without changing the baseline. This catches a recovery that appears only immediately after refresh or restart. Record whether the result persists, whether a new difference appears, and whether the source schedule changed meanwhile. A stable repeat is stronger evidence than one clean pass.

## Verify security and ownership

Confirm that source authorization remains valid, no credential was placed in evidence, certificate checks were not weakened, and temporary access or files created during recovery have an owner and removal plan.

## Classify every row

Use pass, expected source change, unresolved difference, unknown, not applicable, or blocked by missing baseline. Add evidence, owner, and next review date to unresolved rows. Do not state “fully fixed” beyond the tested scope.

## Clean up evidence safely

Keep only records legitimately needed for support, security, or household administration. Delete temporary screenshots and logs according to current privacy and support guidance. The [privacy-safe evidence pack](/blog/guide-issue-support-evidence/) defines redactions.

## Original evidence: recovery scorecard

| Area | Baseline | Recovered state | Classification | Owner |
| --- | --- | --- | --- | --- |
| Original symptom |  |  |  |  |
| Source and channel identity |  |  |  |  |
| Time and now/next |  |  |  |  |
| Filters and search |  |  |  |  |
| Focus and layout |  |  |  |  |
| Scrolling path |  |  |  |  |
| Other device |  |  |  |  |
| Security and records |  |  |  |  |

## Common mistakes and limitations

- Closing after one successful screen.
- Testing a different profile, filter, or guide window.
- Ignoring time, focus, or second-device regressions.
- Declaring complete recovery from a small sample.
- Leaving secrets in temporary evidence.
- Failing to assign unresolved differences.

## Frequently asked questions

### Does one correct listing close the incident?

No. Retest the original symptom and adjacent scoped checks, then assign every unresolved result.

### Must every guide value match the old baseline?

Not necessarily. Legitimate source schedule changes should be documented separately from recovery regressions.

### How large should the audit sample be?

Use the smallest set covering the original symptom, one control, relevant adjacent layers, and another supported device.

## Your next step

[Confirm With Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [NIST Privacy Framework](https://www.nist.gov/privacy-framework)
