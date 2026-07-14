---
content_id: "NVB-098"
title: "Categories Not Updating Across Devices? A Troubleshooting Guide"
seo_title: "Fix Categories Not Updating Across Devices"
meta_description: "Troubleshoot category differences across devices by matching account, profile, source, filters, refresh state, app version, and a known control item."
slug: "categories-not-updating-across-devices"
canonical_url: "https://norva.tv/blog/categories-not-updating-across-devices/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Product Evaluation & Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Why are media categories not updating consistently across devices?"
supporting_questions:
  - "Which account and source differences should I compare?"
  - "How can I refresh without losing useful evidence?"
audience:
  - "Norva users seeing different categories across devices"
  - "Households using web, mobile, and TV"
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
estimated_reading_minutes: 6
excerpt: "Category differences are easiest to diagnose by matching account, profile, source, filters, app version, and refresh state before resetting anything."
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
parent_pillar: "/blog/what-is-norva-media-player/"
related_articles:
  - "/blog/media-library-categories/"
  - "/blog/playback-progress-not-syncing/"
  - "/blog/norva-troubleshooting-checklist/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "two-device category diff sheet"
  summary: "A side-by-side record compares account, profile, source, filters, app versions, category counts, and one known item."
  methodology: "Readers hold the source and item constant, refresh one device at a time, and record which variable makes the category views converge."
  asset_urls: []
---

# Categories Not Updating Across Devices? A Troubleshooting Guide

> **In short:** First confirm that both devices use the same Norva account, intended profile, and connected source. Clear search and category filters, note app versions, and compare one known item before refreshing. Category structures can depend on source data, so a source change may not appear identically until each connected device has refreshed.

“Categories do not match” can mean a missing category, a different item count, a renamed category, or one known item appearing in another place. Define the exact difference before resetting either device.

## Create a two-device baseline

On Device A and Device B, record:

- Norva account identifier without exposing private credentials;
- active profile;
- connected source label;
- app or web version if visible;
- device operating-system or browser version;
- active source, category, availability, language, and search filters;
- category name and displayed item count;
- one known title expected in that category;
- time of the comparison.

Screenshots are useful when they exclude passwords, tokens, private source addresses, and personal account details.

## Match the viewing context

A different profile or source can produce a legitimate difference. Check those before assuming synchronisation failed.

Clear search text and all filters on both devices. Return to the same top-level library area. If one device is viewing favourites, unavailable items, or a language-filtered subset, category counts are not comparable.

The [media library categories guide](/blog/media-library-categories/) explains how categories, filters, and item metadata serve different browsing roles.

## Test one known item

Choose an item whose category assignment is understood from the connected source. Search for it directly on both devices.

- If both find the item but category placement differs, focus on category metadata or refresh state.
- If one cannot find the item at all, broaden the check to source reachability, availability filters, and catalogue refresh.
- If the item appears under different versions, inspect grouped media variants.
- If every known item differs, verify that the sources really match.

One control item is more diagnostic than comparing large visual grids from memory.

## Refresh one device at a time

Use a controlled order:

1. preserve the baseline;
2. verify Device A is connected;
3. use the current in-app refresh route if available;
4. wait for the view to settle without changing filters;
5. record the category and control item again;
6. repeat separately on Device B;
7. close and reopen the app only if needed;
8. restart one device only after the lighter checks.

Avoid signing out or removing the source while useful state remains unrecorded. If other state such as progress also differs, use the [playback progress sync diagnostic](/blog/playback-progress-not-syncing/) to determine whether the symptom is broader.

## Verify the source data

Norva organises catalogue information from a compatible source the user owns or is legally authorised to use. Category names, assignments, and completeness can therefore depend on source data.

Check whether the source itself now exposes the expected category and control item. If the source changed recently, record when. Norva cannot create a source category that is absent upstream.

Do not edit source data solely to make two screenshots match until you know which state is intended.

## Original evidence: category diff sheet

| Field | Device A | Device B |
| --- | --- | --- |
| Account/profile |  |  |
| Source label |  |  |
| App/browser version |  |  |
| Filters cleared | Yes / No | Yes / No |
| Category name/count |  |  |
| Control item found | Yes / No | Yes / No |
| Result after refresh |  |  |

Add a “source verified” row and the test time. The first variable that makes the views agree is useful evidence; it is not proof that every category will always sync immediately.

## When to escalate

Contact the source provider if the expected category or item is absent from its official data. Contact Norva support when both devices clearly use the same account, profile, source, filters, and current data but remain reproducibly different.

Send the diff sheet and steps, not credentials. The [Norva troubleshooting checklist](/blog/norva-troubleshooting-checklist/) provides a safe escalation sequence.

## Common mistakes and limitations

- Comparing different profiles or sources.
- Leaving search or language filters active.
- Comparing a web tab that has not refreshed with a newly opened TV app.
- Resetting both devices simultaneously.
- Assuming category assignment is created independently by Norva.
- Sharing sensitive source details in screenshots.
- Treating a changed count as proof that items were deleted.

Catalogue and category data can change at the source. Record the comparison time.

## Frequently asked questions

### Are categories a profile preference?

Category organisation can reflect source catalogue data, while a profile can affect personal state and filters. Match both source and profile before diagnosing a difference.

### Should I reconnect the source?

Not as a first step. Preserve evidence, clear filters, refresh, and compare a control item. Reconnection can add credential and setup variables.

### Why does search find an item that is absent from a category?

Search visibility and category assignment can rely on different metadata or refresh states. Record the item version and verify its source category.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva support](https://norva.tv/support)
