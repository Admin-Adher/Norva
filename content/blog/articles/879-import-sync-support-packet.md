---
content_id: "NVB-879"
title: "Build a Support Packet for Import and Sync Problems"
seo_title: "Import and Sync Support Packet Checklist"
meta_description: "Document import and sync issues with a redacted symptom, timeline, stable context, visible states, counts, sample identities, comparison, and action log."
slug: "import-sync-support-packet"
canonical_url: "https://norva.tv/blog/import-sync-support-packet/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "support-evidence-guide"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I document import and sync issues for support?"
supporting_questions:
  - "Which symptom, timeline, context, state, count, sample, comparison, and action evidence is useful?"
  - "Which secrets and private catalog data must be excluded?"
audience:
  - "Norva users preparing an import support request"
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
excerpt: "A useful support packet explains one exact symptom, preserves its timeline and stable context, includes minimal samples and comparisons, and excludes credentials and complete catalogs."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/catalog-import-stuck-same-stage/"
  - "/blog/expected-items-missing-after-sync/"
  - "/blog/delayed-sync-after-source-update/"
  - "/blog/import-works-on-one-network-only/"
cta:
  label: "Open Norva Support"
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
  type: "redacted import and sync support packet"
  summary: "A packet contains one symptom statement, first and current timestamps, account and profile context, device and application version, masked source label, filters and grouping, visible state, aggregate counts, sample identities, comparison, and action log."
  methodology: "The user minimizes personal data, removes secrets and private addresses, labels observations and hypotheses separately, includes only representative samples, and reviews the packet before submitting through official support."
  asset_urls: []
---

# Build a Support Packet for Import and Sync Problems

> **In short:** Describe one exact symptom in one sentence, then add first and current timestamps, account and profile context, device and application version, masked source label, filters and grouping, visible import or sync state, aggregate counts, a few privacy-safe item samples, one controlled comparison, and every action taken. Remove credentials, recovery codes, private addresses, complete catalogs, and unrelated household history before submitting through official Norva support.

A concise evidence packet reduces repeated questions and protects household data. Its job is to show what happened and under which context, not to prove an undocumented technical theory.

## Start with one symptom statement

Use an observable sentence: “The operation completed with zero visible items on device A,” or “Sample B appears on device A but not device B.” Avoid “sync is broken” because it combines result and cause.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) lists the main symptom branches.

## Build a timestamped sequence

Include source change or confirmation, request time, visible acknowledgment, every stage or message change, completion or last change, first symptom observation, controlled comparison, and current state. Add timezone and observation gaps.

For an unchanged stage, use the [stalled-stage timeline](/blog/catalog-import-stuck-same-stage/). For delayed source changes, use the [delayed-sync record](/blog/delayed-sync-after-source-update/).

## Record stable context

List Norva account in masked form, active profile, device model, operating system, application version, network type, authorized source label, enabled sources, availability, category, filters, search, sort, and grouping. Note which values stayed fixed and which changed.

## Copy exact visible state

Transcribe the message, stage, displayed count, enabled or disabled control, and relevant status. Attach a redacted screenshot only when it communicates more than text. Crop out notifications, account addresses, other household titles, and source details.

## Add representative samples

Use up to three neutral sample codes. For each, record source label, year, media type, season or episode, duration, version, artwork state, presence, progress or favorite state only when relevant, and source confirmation. The [missing-item checklist](/blog/expected-items-missing-after-sync/) provides a compact table.

## Include one controlled comparison

Describe a comparison where one variable changed: another supported device, another trusted network, or one visible filter. Record both baselines and outcomes. If several variables changed, state that limitation rather than presenting the result as controlled.

The [two-network comparison](/blog/import-works-on-one-network-only/) shows the required network safety boundaries.

## List every action taken

Record retries, reloads, sign-outs, device restarts, source edits, credential changes, application updates, and data clearing with timestamps. An action that seems unimportant can explain why support cannot reproduce the first state.

## Separate observations from hypotheses

Use two fields. “The source returned the sample at 15:10” is an observation. “A local cache is stale” is a hypothesis unless verified. Do not describe internal queues, matching, storage, or timing as fact without current product documentation.

## Remove sensitive data

Exclude passwords, tokens, recovery codes, payment data, full endpoint or playlist addresses, public addresses, complete catalogs, complete viewing history, and unrelated profile data. Mask account and source labels while keeping them distinguishable. Norva's current privacy notice should guide data minimization.

## Review ownership and destination

Send provider-specific access evidence to the authorized provider, network evidence to the network owner, and Norva interface evidence through official Norva support. Do not post the packet publicly. Keep access limited and delete temporary copies when no longer needed under applicable guidance.

## Original evidence: redacted support packet

| Section | Required evidence |
| --- | --- |
| Symptom | One observable sentence |
| Timeline | First request through current state |
| Context | Account, profile, device, version, network |
| View | Sources, filters, grouping, count |
| Samples | Up to three redacted identities |
| Comparison | One changed variable |
| Actions | Complete timestamped log |
| Privacy review | Secrets and unrelated data removed |

## Common mistakes and limitations

- Sending a broad conclusion instead of one symptom.
- Omitting retries or destructive actions.
- Attaching complete private catalogs or history.
- Including credentials or full source addresses.
- Mixing observations with implementation guesses.
- Posting the packet in a public channel.

## Frequently asked questions

### Should I include full logs?

Only include logs current support requests, after reviewing and redacting secrets and unrelated personal data. A focused packet is safer by default.

### How many item samples are useful?

Use the smallest representative set, commonly up to three, plus aggregate counts and stable context.

### Can I send screenshots?

Yes when needed, but crop and redact account data, source details, notifications, unrelated titles, and any secret before submission.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [NIST Privacy Framework](https://www.nist.gov/privacy-framework)
