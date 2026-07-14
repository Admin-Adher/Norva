---
content_id: "NVB-847"
title: "Why You Should Connect One New Source at a Time"
seo_title: "Connect One New Media Source at a Time"
meta_description: "Connect one source at a time, keep a baseline, change one variable, verify catalog and playback, document errors, and define rollback before continuing."
slug: "connect-one-source-at-a-time"
canonical_url: "https://norva.tv/blog/connect-one-source-at-a-time/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "controlled-change-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Why should I connect only one new media source at a time?"
supporting_questions:
  - "How does a single-variable setup isolate catalog and connection changes?"
  - "Which baseline, success, error, and rollback evidence should be recorded?"
audience:
  - "Norva users adding compatible sources"
  - "Households troubleshooting multiple catalog inputs"
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
excerpt: "Adding one source per change window makes authorization, address, authentication, catalog, duplicate, playback, and rollback outcomes attributable to one controlled action."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/authorized-source-connection-planning-guide/"
  - "/blog/baseline-before-second-source/"
  - "/blog/check-source-reachability-before-adding/"
  - "/blog/credential-entry-error-without-exposure/"
cta:
  label: "Open Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://norva.tv/terms"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "single-source controlled change log"
  summary: "A log captures authorization, masked label, baseline, one changed source, timestamp, device, app version, address check, reachability, authentication, catalog delta, playback sample, errors, rollback, and decision."
  methodology: "The user freezes unrelated settings, adds one owned or authorized source, records one layer at a time, tests a small non-sensitive sample, avoids repeated retries, and restores the baseline before another attempt when needed."
  asset_urls: []
---

# Why You Should Connect One New Source at a Time

> **In short:** Freeze unrelated settings, record the current catalog baseline, and add one compatible source that you own or are authorized to use. Note the timestamp, device, application version, label, address-validation result, reachability, and authentication outcome. Then compare source availability, categories, duplicates, metadata, playback, audio, subtitles, and supported-device behavior. If results fail, remove or disable only that new configuration and verify the baseline returns before changing another source or variable.

A single-source change creates attribution. When several sources, filters, and credentials change together, the household cannot tell which action caused a missing category or duplicate item.

## Freeze the current environment

Record application and operating-system versions, active filters, grouping options, source availability settings, and network context. Avoid updates or plan changes during the same test window when possible.

The [planning guide](/blog/authorized-source-connection-planning-guide/) confirms authorization, account security, and setup readiness first.

## Capture a baseline

Use the [catalog-baseline guide](/blog/baseline-before-second-source/) to record existing source count, category totals, sample titles, metadata completeness, duplicates, progress, favorites, and one playback sample without collecting sensitive viewing details.

A baseline should be small enough to repeat.

## Add one authorized source

Use a privacy-safe label and the exact documented fields. Record the time of save and the trusted setup device. Do not edit the first source, create another account, or change filters simultaneously.

Protect source credentials and never place them in the change log.

## Verify technical layers in order

Confirm address format, reachability, endpoint identity, and then authentication. The [reachability guide](/blog/check-source-reachability-before-adding/) prevents a timeout from being treated as a password error.

If credential entry fails, follow the [credential-error guide](/blog/credential-entry-error-without-exposure/) without sending secrets to support.

## Compare catalog behavior

Check whether the new source is identifiable, whether expected categories appear, whether item counts change plausibly, and whether duplicates or grouped versions behave according to current settings. Record observations, not assumptions about source priority.

Do not copy an entire catalog into the log.

## Test a small playback sample

Use authorized media and test a small representative sample for start, seeking, audio selection, subtitles, and completion state where available. Offline behavior requires separate eligibility and device conditions.

One successful item does not prove the whole source is healthy, but a controlled sample can expose configuration differences.

## Define success and stop conditions

Success should include recognized source, expected catalog delta, no unexplained loss from the baseline, and acceptable sample behavior. Stop after an identity warning, repeated authentication rejection, unexpected catalog replacement, or exposure risk.

Do not keep retrying with altered secrets.

## Roll back cleanly

Remove or disable only the new source using current controls. Confirm the original catalog, filters, favorites, and playback sample return to baseline. Do not delete the external source account.

After a stable success or verified rollback, begin a separate change window for another source.

## Allow an observation window

Some catalog state may update after the initial save, but do not invent a universal wait. Record immediate results and any later change with timestamps. Keep the application version, filters, profile, and network stable during observation. If official support gives a processing expectation, cite it for that case. Proceed only when the source is stable enough to distinguish a later second-source effect.

## Original evidence: single-source controlled change log

| Stage | Evidence | Result |
| --- | --- | --- |
| Authorization | Owner and scope confirmed |  |
| Baseline | Counts, settings, sample |  |
| Change | One masked source and timestamp |  |
| Technical layers | Format, reachability, identity, auth |  |
| Catalog delta | Categories, counts, duplicates |  |
| Playback sample | Start, seek, audio, subtitles |  |
| Rollback | New source removed only |  |
| Decision | Keep, clarify, or stop |  |

## Common mistakes and limitations

- Adding several sources in one session.
- Updating filters and application version simultaneously.
- Recording credentials in the change log.
- Calling every failure an authentication error.
- Testing a whole catalog instead of a safe sample.
- Rolling back by deleting the external account.
- Continuing after an endpoint-identity warning.

## Frequently asked questions

### Why not add all sources and compare later?

Multiple simultaneous changes make catalog, duplicate, filter, network, and credential effects difficult to attribute or reverse safely.

### How long should I wait before the next source?

Proceed after the current source has a documented stable result or verified rollback; do not invent a universal synchronization delay.

### Does removal from Norva delete the source account?

Do not assume so. Removing a configuration and deleting an external source account are separate actions.

## Your next step

[Open Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva terms of service](https://norva.tv/terms)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
