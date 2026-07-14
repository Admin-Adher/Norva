---
content_id: "NVB-259"
title: "How to Document a Program Guide Data Problem for Support"
seo_title: "Document a Program Guide Data Problem for Support"
meta_description: "Create a privacy-safe guide report with service and event identifiers, timestamps, zone, source freshness, device context, reproduction steps, and evidence."
slug: "document-guide-data-problem"
canonical_url: "https://norva.tv/blog/document-guide-data-problem/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should a program guide data problem be documented for support?"
supporting_questions:
  - "Which fields make a guide issue reproducible?"
  - "What private information should be excluded?"
audience:
  - "Viewers preparing a useful support report"
  - "Norva users troubleshooting guide metadata"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A privacy-safe incident bundle gives support enough identity, timing, source, and reproduction evidence without exposing credentials."
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
parent_pillar: "/blog/live-program-guide-literacy/"
related_articles:
  - "/blog/check-program-guide-freshness/"
  - "/blog/spot-stale-program-descriptions/"
  - "/blog/interpret-overlapping-listings/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://dvb.org/metadata/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "privacy-safe guide incident bundle"
  summary: "The bundle captures a one-sentence symptom, service and event identity, absolute timing, source and retrieval state, device context, minimal reproduction, expected and actual results, scope, and redacted evidence."
  methodology: "Readers reproduce once from a clean baseline, change one factor, redact secrets, name attached files, and verify the report can be understood without private access."
  asset_urls: []
---

# How to Document a Program Guide Data Problem for Support

> **In short:** Report one symptom with exact service and event identifiers, full timestamps and zone, source freshness, device and app context, minimal reproduction steps, expected result, actual result, and a privacy-safe screenshot. Exclude credentials, private source addresses, payment data, and unrelated viewing history. Reproduce once; do not destroy the original state before capturing it.

“Guide wrong” gives support no reliable target. A good report identifies the affected metadata layer and makes the observation repeatable without requiring access to the reporter’s private account.

## Build the incident bundle

| Field | Entry |
|---|---|
| One-sentence symptom |  |
| Service identifier and display name |  |
| Event identifier and title |  |
| Start, duration, full date, zone |  |
| Source refresh or retrieval time |  |
| Device, operating system, app/browser version |  |
| Account context without secrets |  |
| Reproduction steps |  |
| Expected result |  |
| Actual result |  |
| Scope and control comparison |  |
| Attachments and redactions |  |

Use “description belongs to another episode” or “two events overlap by 15 minutes” rather than a broad conclusion.

## Preserve the first observation

Before refreshing or changing filters, capture:

- current guide clock and zone;
- selected service;
- visible event boundaries;
- active filters and view;
- source or account state indicator;
- error or status message.

W3C notification guidance supports capturing the exact status and recovery text. Do not paraphrase an error if the original can be copied safely.

## Identify the affected layer

Choose one primary class:

- service identity or logo;
- event title or episode identity;
- description or category;
- start, duration, date, or time zone;
- schedule gap or overlap;
- freshness or coverage horizon;
- listing visible but playback access fails;
- interaction or rendering problem.

Use [the stale-description workflow](/blog/spot-stale-program-descriptions/) for text conflicts and [the overlap ledger](/blog/interpret-overlapping-listings/) for competing intervals.

## Write minimal reproduction steps

A useful sequence is:

1. open the guide on the named device;
2. select the specified service;
3. set or record the date, zone, and view;
4. clear or list active filters;
5. navigate to the exact event;
6. observe the stated field;
7. refresh once and record whether it changes.

Avoid optional steps and do not bundle several unrelated symptoms into one report.

## Add expected evidence

Explain why a different result is expected. Cite a stronger current source, stable identifier, newer revision, or cross-device control. “I remember another title” is not enough. If no authoritative correction exists, ask support to investigate rather than asserting the replacement value.

Run [the guide freshness audit](/blog/check-program-guide-freshness/) and include its retrieval time and coverage result.

## Protect privacy and security

Redact:

- passwords, tokens, keys, and authorization headers;
- private source URLs or credentials;
- email addresses and billing details;
- unrelated account names;
- household viewing history outside the issue;
- notification content from other apps.

Crop screenshots to the relevant guide area while retaining service, event, clock, and zone context. Check image metadata if it may reveal location or device information you did not intend to share.

## Name and order attachments

Use descriptive filenames such as `before-refresh-tv-2026-07-14-2012.png` and `after-refresh-mobile-2026-07-14-2015.png`. Explain each attachment in the report. Do not send a large unlabelled video when two focused screenshots and a short step list establish the issue.

DVB metadata work helps distinguish service and program information, which should be reflected in the report fields.

## Define the scope

State whether the issue affects one event, one service, one device, all devices, or the entire guide window. A working control service or device is valuable evidence. Do not reset unrelated library data to expand the test.

Norva support can investigate product behavior, while source data quality may remain an upstream responsibility. The bundle helps identify that boundary without exposing private access details.

## Common mistakes and limitations

- Reporting no absolute timestamp or zone.
- Omitting service and event identifiers.
- Refreshing before capturing the baseline.
- Combining metadata and playback symptoms.
- Attaching secrets or unrelated history.
- Supplying an invented correction.

## Frequently asked questions

### Should I include a screen recording?

Only when motion or navigation is essential. Redact notifications and private data, and accompany it with written steps.

### How many devices should I test?

One affected device plus one relevant control is usually more useful than many undocumented retries.

### What if the problem disappears after refresh?

Report the before and after states with timestamps. That outcome still helps identify stale client data.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [DVB Metadata](https://dvb.org/metadata/)
- [Norva Support](https://norva.tv/support)
