---
content_id: "NVB-861"
title: "The Complete Catalog Import and Sync Troubleshooting Handbook"
seo_title: "Catalog Import and Sync Troubleshooting Handbook"
meta_description: "Troubleshoot catalog import and sync issues by preserving a timeline, separating source, account, profile, device, filter, metadata, and identity signals."
slug: "catalog-import-sync-troubleshooting-handbook"
canonical_url: "https://norva.tv/blog/catalog-import-sync-troubleshooting-handbook/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-handbook"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot catalog import and synchronization problems?"
supporting_questions:
  - "Which source, account, profile, device, filter, metadata, and identity signals should be separated?"
  - "What evidence helps support without exposing private catalog or credential data?"
audience:
  - "Norva users diagnosing catalog changes"
  - "Household administrators managing authorized sources"
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
estimated_reading_minutes: 9
excerpt: "A disciplined import and sync investigation preserves one timeline, freezes viewing context, and separates source response from account, profile, device, filter, metadata, and item-identity signals."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/catalog-import-will-not-start/"
  - "/blog/catalog-import-stuck-same-stage/"
  - "/blog/import-finishes-with-zero-items/"
  - "/blog/expected-items-missing-after-sync/"
  - "/blog/one-device-shows-old-catalog/"
cta:
  label: "Open Norva Support"
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
  type: "catalog import and sync diagnostic matrix"
  summary: "A matrix records the first symptom, timeline, source observation, account and profile context, device and application version, filters and grouping, counts, sample identities, artwork, progress, and controlled comparisons."
  methodology: "The user freezes context, records ordinary interface evidence, changes one reversible variable at a time, compares a minimal authorized sample, and separates observations from hypotheses before contacting support."
  asset_urls: []
---

# The Complete Catalog Import and Sync Troubleshooting Handbook

> **In short:** Record the first symptom and a precise timeline before repeating anything. Separate source reachability, Norva import state, account and profile context, device display, filters and grouping, metadata and artwork, and item identity. Compare a small authorized sample on stable settings, change one reversible variable at a time, and send support redacted observations rather than credentials, complete catalogs, or claims about undocumented architecture.

An import or sync symptom can appear simple while crossing several layers. The safest investigation starts with what the interface shows and avoids guessing how Norva or an external source works internally.

## Name the first visible symptom

Choose the earliest observation: the operation does not begin, remains at the same displayed stage, completes with zero items, shows an unexpected count, omits known entries, duplicates cards, lacks artwork, or differs on one device. Later effects may share a cause, but combining them immediately weakens the timeline.

Use the [import-start checklist](/blog/catalog-import-will-not-start/) when no visible start occurs and the [stalled-stage timeline](/blog/catalog-import-stuck-same-stage/) when a displayed stage does not change.

## Freeze the comparison context

Record the account, profile, device, application version, network, authorized source label, time, filters, availability choices, category, sort, and grouping state. Keep those values stable while observing. A different profile or hidden filter can look like a catalog loss even when the comparison itself changed.

Do not clear application data, remove the source, reinstall, or trigger repeated operations before preserving evidence.

## Separate seven evidence layers

Treat these as distinct until evidence connects them:

1. The authorized source's own availability and response.
2. The visible Norva import or sync state.
3. The signed-in account and active profile.
4. Device-local display and application version.
5. Filters, categories, availability, sorting, and grouping.
6. Metadata and artwork retrieval or presentation.
7. The identity of an item, episode, source version, favorite, or progress entry.

HTTP status information can describe a response, but it does not by itself establish which layer caused the user-facing result. RFC 9110 is useful for protocol semantics, not for inventing Norva behavior.

## Build one timeline

Record when the source changed, when the operation was requested, the exact visible stage or message, the last observed change, displayed counts, and every action taken afterward. Use device-local time with timezone. If official support publishes a timing expectation, cite the current page; otherwise describe the elapsed observation without declaring a universal deadline.

For a source update followed by a delay, use the [delayed-sync record](/blog/delayed-sync-after-source-update/).

## Compare a minimal authorized sample

Select a few entries that represent the symptom: one expected item, one item that appears, one category, and one alternate version or episode when relevant. Record privacy-safe sample codes, visible source and version labels, year, duration, category, artwork state, and device. Avoid exporting the household's full catalog or history.

If the operation reports success but shows nothing, follow the [zero-item separation guide](/blog/import-finishes-with-zero-items/). If only specific entries are absent, use the [missing-item evidence checklist](/blog/expected-items-missing-after-sync/).

## Change one reversible variable

Compare the same profile and sample after one low-risk change, such as removing a visible filter or checking another supported trusted device. Return to the baseline before the next comparison. Repeated imports, refreshes, credential edits, source removal, and bulk deletion can alter the evidence and may amplify duplicates or identity confusion.

A difference on only one device belongs in the [older-catalog cross-screen check](/blog/one-device-shows-old-catalog/), not in an unsupported claim that source data is stale.

## Keep content identity explicit

Similar titles or artwork do not prove two cards represent the same entry. Compare visible source label, version, year, duration, season, episode, and other ordinary distinctions. A favorite or progress marker may appear changed when a source refresh exposes another item identity. The [progress identity audit](/blog/progress-reset-after-item-identity-change/) handles that case without assuming a hidden matching algorithm.

## Separate metadata from media availability

Text metadata, artwork, a catalog card, and playable media are different observations. Missing artwork does not prove the media entry is absent, and visible metadata does not prove a usable entry is currently available. Use the [artwork diagnostic](/blog/artwork-missing-after-import/) and record exactly which elements appear.

## Escalate with a compact evidence packet

Send Norva support the symptom, timeline, account or profile context without unnecessary personal data, device and application version, masked source label, filters and grouping, displayed state, aggregate counts, sample codes, and controlled comparison. Never include passwords, tokens, recovery codes, complete private addresses, or a full catalog export.

## Original evidence: import and sync diagnostic matrix

| Layer | Baseline | Current observation | Controlled comparison |
| --- | --- | --- | --- |
| Source availability |  |  |  |
| Import or sync state |  |  |  |
| Account and profile |  |  |  |
| Device and version |  |  |  |
| Filters and grouping |  |  |  |
| Count and sample identity |  |  |  |
| Metadata and artwork |  |  |  |
| Progress or favorites |  |  |  |

## Common mistakes and limitations

- Repeating the operation before recording the first result.
- Treating a count as proof of exact catalog membership.
- Comparing different profiles, filters, or grouping states.
- Assuming a one-device display represents every device.
- Conflating metadata, artwork, catalog presence, and playback.
- Sending credentials or complete private catalog data to support.

## Frequently asked questions

### How long should a catalog import or sync take?

Use only a current timing statement from official Norva support if one exists. Otherwise record elapsed time and visible changes without inventing a deadline.

### Should I run the operation again immediately?

Not before preserving the first timeline and checking current official guidance. Repetition can make cause and effect harder to separate.

### What is the most useful support evidence?

The exact symptom, timestamps, visible state, device and version, stable context, aggregate counts, privacy-safe samples, and one controlled comparison are usually more useful than broad conclusions.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
