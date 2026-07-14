---
content_id: "NVB-438"
title: "How to Document a Cross-Device Handoff Failure"
seo_title: "Document a Cross-Device Handoff Failure"
meta_description: "Create a support-ready handoff report with source and target states, exact steps, expected and observed results, one controlled comparison, and redacted evidence."
slug: "how-to-document-a-cross-device-handoff-failure"
canonical_url: "https://norva.tv/blog/how-to-document-a-cross-device-handoff-failure/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-guide"
topic_cluster: "Cross-Device Handoff"
search_intent: "report handoff failure"
funnel_stage: "retention"
primary_question: "How should I document a cross-device handoff failure?"
supporting_questions:
  - "Which source and target details are essential?"
  - "How can I avoid exposing private data?"
audience:
  - "Viewers preparing a Norva support request"
  - "People testing reproducible handoff problems"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Create a support-ready handoff report with source and target states, exact steps, expected and observed results, one controlled comparison, and redacted evidence."
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
parent_pillar: "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
related_articles:
  - "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
  - "/blog/build-a-device-to-device-handoff-test-matrix/"
  - "/blog/how-to-recheck-a-handoff-after-an-app-update/"
cta:
  label: "Send a Prepared Report to Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html"
  - "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "cross-device failure report template"
  summary: "A support template captures paired device states, minimal reproduction steps, expected and observed results, and sanitised evidence."
  methodology: "Readers preserve the first failure, reproduce once from a known state, change one condition in a comparison, and redact all account and source secrets."
  asset_urls: []
---
# How to Document a Cross-Device Handoff Failure

> **In short:** Record source and target environments, account and profile context, item and version identity, both positions, exact steps, expected result, observed result, and the first visible message. Reproduce once from a known state, then change only one condition. Redact credentials, private URLs, payment data, profile names, and unrelated history before contacting support.

A report should describe what failed, not guess why. “Handoff is broken” cannot be reproduced. “The target opens the same episode and version at an older recorded position after one resume action” can be investigated.

## Preserve the first failure

Pause both screens and capture:

- source and target device roles;
- operating-system and app/browser versions if visible;
- account and profile category;
- network type;
- item, episode, and version;
- source and target positions;
- audio and subtitle states;
- exact error or status text.

Do not seek, clear data, reinstall, or repeatedly sign in before this capture.

## Write a one-sentence symptom

Use:

“From [source state], after [single action] on [target state], I observe [visible result] instead of [expected result].”

Keep interpretation out of the sentence. W3C error-identification and status-message guidance explains the value of clear feedback, but it does not diagnose a specific Norva failure.

## Reproduce from a known state

1. Confirm the source profile and item.
2. Pause at a recorded position.
3. Open the verified target route.
4. Confirm target profile, item, and version.
5. Activate resume once.
6. Stop at the first failure.
7. Record whether the result repeats.

The [cross-device state guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) defines the prerequisite order.

## Run one controlled comparison

Change one variable only:

- another authorised item on the same pair;
- same item after verified reauthentication;
- same target on another trusted network;
- same source with another supported target;
- same version with a different available track.

Use [the device-pair test matrix](/blog/build-a-device-to-device-handoff-test-matrix/) when several pairs require review. A comparison narrows conditions; it does not prove root cause.

## Redact evidence

Before sharing a screenshot or recording, remove:

- passwords and recovery codes;
- email addresses and private profile names;
- source credentials and URLs;
- account or payment identifiers;
- unrelated notifications;
- private catalogue details not needed for the symptom.

When redaction removes the useful state, describe it in text. Never upload full app storage or configuration files without verified support instructions.

## Original evidence: failure report

- **Date, time, and time zone:** ___
- **Source device/version:** ___
- **Target device/version:** ___
- **Account/profile category:** ___
- **Network condition:** ___
- **Item/episode/version safe to share:** ___
- **Source position:** ___
- **Target position:** ___
- **Exact steps:** 1. ___ 2. ___ 3. ___
- **Expected result:** ___
- **Observed result:** ___
- **Visible message:** ___
- **One-variable comparison:** ___
- **Reproducibility:** once / repeated / intermittent
- **Sanitised attachment:** ___

This template is support-ready only after a human verifies that sensitive data is absent.

## After an update

If the failure appeared after an app update, do not assume causation. Compare versions and documented baselines using [the post-update handoff recheck](/blog/how-to-recheck-a-handoff-after-an-app-update/).

State “first observed after update” rather than “caused by update” unless evidence establishes the relationship.

## When to stop

Stop if a security warning appears, the account context changes unexpectedly, the device reports abnormal heat or hardware trouble, or repeated tests alter another person's progress. Follow device guidance or support instructions.

## Common mistakes and limitations

Avoid vague symptoms, missing version identity, several simultaneous changes, unredacted video, invented timing thresholds, and claiming a universal outage from one device pair.

A complete report improves reproducibility but cannot guarantee a diagnosis, response time, or fix.

## Preserve direction as part of the symptom

Record source-to-target direction explicitly. A phone-to-TV failure and TV-to-phone failure are separate routes even when they use the same media item. Test the reverse direction only as a labeled control, not as a replacement for the original reproduction.

## Frequently asked questions

### Should I include the media title?

Only when it is necessary and safe. A neutral identifier or redacted title can preserve privacy while distinguishing the test item.

### How many times should I reproduce the failure?

Once after the first capture is usually enough for a safe initial report. Avoid repeated actions that change state.

### Should I publish the report publicly?

No. Use the verified support route and share only the minimum sanitised evidence.

## Your next step

[Send a prepared report to Norva Support](https://norva.tv/support)

## Sources

- [W3C: Understanding Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html)
- [W3C: Understanding Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- [Norva Support](https://norva.tv/support)
