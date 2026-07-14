---
content_id: "NVB-866"
title: "Duplicate Items After a Repeat Import? What to Compare"
seo_title: "Duplicate Items After a Repeat Import"
meta_description: "Diagnose duplicate items after repeated imports by preserving the timeline and comparing source, version, grouping, filters, profile, device, and identity."
slug: "duplicates-after-repeat-import"
canonical_url: "https://norva.tv/blog/duplicates-after-repeat-import/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "duplicate-item-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose duplicates created after repeated import?"
supporting_questions:
  - "Which request, source, item, version, metadata, grouping, filter, profile, and device facts should be compared?"
  - "How can cleanup wait until a reliable baseline exists?"
audience:
  - "Norva users seeing apparent catalog duplicates"
  - "Household administrators after repeated imports"
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
excerpt: "A duplicate investigation preserves every import request, then compares visible source, version, metadata, grouping, profile, device, and item identity before any cleanup."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/catalog-count-changes-between-imports/"
  - "/blog/grouped-versions-split-after-refresh/"
  - "/blog/expected-items-missing-after-sync/"
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
  type: "repeat-import duplicate comparison"
  summary: "A comparison records each import request and result, source labels, visible item and version cues, metadata differences, filters, grouping, profile, device, counts, and a small set of apparent duplicate pairs."
  methodology: "The user stops repeated actions, freezes context, compares ordinary interface identity cues for a minimal sample, classifies exact, alternate-version, metadata, or unknown pairs, and delays deletion until support review."
  asset_urls: []
---

# Duplicate Items After a Repeat Import? What to Compare

> **In short:** Stop importing and preserve the full request timeline. Freeze the same account, profile, device, application version, source selection, filters, sort, and grouping. For a few apparent duplicate pairs, compare visible source labels, titles, years, seasons, episodes, durations, versions, language cues, artwork, and progress. Classify exact-looking pairs, alternate versions, metadata variations, or unknowns without guessing hidden identifiers, then contact support before bulk deletion.

Two similar cards are not automatically duplicate records. They may represent different sources, editions, episodes, language versions, or metadata states. Repeated actions add a timing question that should be documented, not assumed causal.

## Stop the sequence

Record every import request, its timestamp, visible acknowledgment, stage, completion result, and the first moment additional cards appeared. Include retries, page reloads, device restarts, source edits, and filter changes. Do not run another operation while gathering evidence. Keep the original catalog state available until support reviews it.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) provides the wider evidence matrix.

## Restore one viewing context

Use the same Norva account, profile, device, application version, source availability, category, search query, filters, sorting, and grouped-version state. Record each value. A disabled grouping control or another profile can make existing versions appear as extra cards.

## Select a minimal pair sample

Choose two or three pairs that represent the pattern. Assign privacy-safe sample codes. Do not export the catalog or capture unrelated household titles. Record whether the apparent duplicates occur in one category, across categories, or only in search.

## Compare visible identity cues

For each card, compare source label, title, year, media type, season, episode, duration, resolution or version label, audio and subtitle cues, artwork, description, availability, and progress where shown. Note differences exactly. Do not inspect source databases or infer Norva's matching key.

If grouped versions separated after a refresh, use the [split-version comparison](/blog/grouped-versions-split-after-refresh/).

## Compare the source itself

Through the authorized provider's official route, determine whether it exposes one entry or several visible versions for each sample. Also note whether another connected source supplies the same logical title. Source-side multiplicity is evidence, not a guarantee of how Norva should display it.

## Quantify without overcounting

Record the displayed catalog total before and after, the number of sampled pairs, and which categories changed. Do not subtract the number of visible pairs and call the remainder the “correct” total. The [catalog-count guide](/blog/catalog-count-changes-between-imports/) explains why totals depend on scope and viewing controls.

## Protect progress and favorites

Check whether each card has distinct progress, completion, or favorite state. Do not open, mark, merge, unfavorite, or delete cards merely to test identity. Those actions can change the evidence and household state.

## Avoid bulk cleanup

Bulk deletion, source removal, repeated refreshes, metadata edits, and credential changes can erase the comparison or affect legitimate alternate versions. Preserve a baseline and follow current Norva support guidance. If an action is recommended, test the smallest reversible scope first and record its result.

## Classify without claiming a cause

Use: visibly identical, different source, alternate version, different episode, metadata variation, grouping difference, device-specific display, or unknown. Keep the repeated-import timeline next to the classification, but do not state that repetition created duplicates unless the evidence and current support guidance establish it.

## Original evidence: repeat-import duplicate comparison

| Field | Card A | Card B | Same or different |
| --- | --- | --- | --- |
| Source label |  |  |  |
| Title, year, type |  |  |  |
| Season, episode, duration |  |  |  |
| Version and language cues |  |  |  |
| Artwork and metadata |  |  |  |
| Progress and favorite |  |  |  |
| Import timeline relation |  |  |  |

## Common mistakes and limitations

- Running another import before saving the timeline.
- Calling same-title cards exact duplicates without comparing versions.
- Changing grouping or filters during the comparison.
- Deleting cards that hold distinct progress or favorite state.
- Inferring undocumented matching or deduplication rules.
- Sharing a complete private catalog with support.

## Frequently asked questions

### Should I delete one of the cards?

Not before comparing identity, preserving household state, and checking current Norva support guidance. A card may represent a legitimate version.

### Did the repeated import definitely create duplicates?

The timing is relevant, but it does not establish causation alone. Preserve every request and compare source and item identity.

### What sample should I send support?

Send a few redacted pairs, their visible differences, stable viewing context, aggregate counts, and the complete action timeline without credentials.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
