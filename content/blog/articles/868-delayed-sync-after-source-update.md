---
content_id: "NVB-868"
title: "Catalog Sync Delayed After a Source Update? What to Record"
seo_title: "Catalog Sync Delayed After a Source Update"
meta_description: "Diagnose delayed sync after source updates by recording change and observation times, source confirmation, visible state, account, profile, device, and samples."
slug: "delayed-sync-after-source-update"
canonical_url: "https://norva.tv/blog/delayed-sync-after-source-update/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "delayed-sync-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose delayed sync after source changes?"
supporting_questions:
  - "Which source-change, visible state, account, profile, device, filter, and sample timestamps matter?"
  - "How can elapsed time be reported without inventing a synchronization promise?"
audience:
  - "Norva users awaiting catalog changes"
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
excerpt: "A delayed-sync record connects the confirmed source update to visible Norva states and timestamped item samples while keeping account, profile, device, filters, and grouping stable."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/catalog-import-stuck-same-stage/"
  - "/blog/one-device-shows-old-catalog/"
cta:
  label: "Check Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.rfc-editor.org/rfc/rfc9110"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source-update synchronization timeline"
  summary: "A timeline records the source change, source confirmation, Norva request and visible states, account and profile, devices and versions, filters and grouping, and first appearance of three privacy-safe samples."
  methodology: "The user confirms the source change through its official route, freezes viewing context, records observations without repeated requests, compares one supported device, and uses official timing only when published."
  asset_urls: []
---

# Catalog Sync Delayed After a Source Update? What to Record

> **In short:** Record the exact source-change time, who made it, when the authorized source first confirmed it, any Norva sync request or displayed state, and when each sampled item changed. Keep the same account, profile, device, application version, filters, category, and grouping. Compare one trusted supported device without launching another operation. Use only current official timing guidance; otherwise report elapsed observations and avoid claiming a universal delay.

A delayed result is a relationship between at least two timestamps: when the source changed and when Norva displayed the change. Without both, “late” is only an impression. This preserves a clean source-to-screen sequence for later support review.

## Define the source update

Record what changed: an item was added or removed, metadata changed, artwork changed, a category changed, or a source address or account changed. Note the authorized actor and timezone. Do not expose private titles when a neutral sample code works.

## Confirm the source state

Through the provider's official authorized route, record when the new state first became visible there. A change submitted at one time may be confirmed later. Keep submission and confirmation timestamps separate and do not infer provider processing details.

## Record the Norva sequence

Note any user-requested sync time, visible acknowledgment, stage, last change, completion message, and displayed count. If no operation began, use the [import-start guide](/blog/catalog-import-will-not-start/). If a stage remains unchanged, use the [stage timeline](/blog/catalog-import-stuck-same-stage/).

## Freeze viewing context

Keep the same Norva account, profile, source selection, category, filters, search query, sorting, grouping, device, application version, and network. A change to any of these can hide or expose an item independently of the source update.

The [full troubleshooting handbook](/blog/catalog-import-sync-troubleshooting-handbook/) separates those layers.

## Track a small sample

Choose up to three changed entries and record source label, media type, year, version, category, artwork state, and visible metadata. At each observation, record present, absent, changed, unchanged, or unknown. Do not repeatedly open or play items just to force a state change.

## Compare another supported device

On one trusted device, match the account, profile, source selection, filters, grouping, and approximate time. Record both application versions. If the source update appears on one screen first, classify a cross-device difference; do not automatically call the other device's data cached or corrupted.

Use the [one-device older-catalog check](/blog/one-device-shows-old-catalog/) for that branch.

## Observe without creating new sequences

Repeated sync requests, source removal and re-addition, credential edits, application-data clearing, and rapid filter changes make it difficult to connect a displayed change to the original event. Preserve the first sequence. If support asks for a retry, record it as a separate sequence with its own baseline.

## Use timing language carefully

If current Norva support publishes an expected timing range, cite that page and the date checked. If it does not, state “not visible after the documented interval” and provide timestamps. RFC 9110 can explain a provider response, but it cannot supply a Norva synchronization promise.

## Escalate with redacted evidence

Send the source submission and confirmation times, Norva request and state times, device and version, account and profile context, filters and grouping, masked source label, aggregate counts, and privacy-safe sample timeline. Exclude credentials, private addresses, and complete catalogs.

## Original evidence: source-update synchronization timeline

| Event | Time and timezone | Device or system | Observation |
| --- | --- | --- | --- |
| Source change submitted |  | Source |  |
| Source change confirmed |  | Source |  |
| Norva request |  |  |  |
| Visible state change |  |  |  |
| Sample A changed |  |  |  |
| Sample B changed |  |  |  |
| Second-device check |  |  |  |

## Common mistakes and limitations

- Using the source edit time as its confirmation time.
- Repeating sync before preserving the first sequence.
- Changing filters, profile, or grouping during observation.
- Inventing an expected delay without official guidance.
- Assuming one device proves every device has the same state.
- Sharing complete catalog or credential data.

## Frequently asked questions

### How long should I wait for a source update?

Use current Norva support guidance if it publishes a range. Otherwise report exact elapsed observations and ask support without inventing a promise.

### Should I trigger sync repeatedly?

No. Preserve the original sequence. Repeat only when current guidance requests it and record the retry as a separate test.

### What if the change appears on one device first?

Record both contexts and application versions. That is cross-device evidence, not proof of a specific local or server cause.

## Your next step

[Check Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
