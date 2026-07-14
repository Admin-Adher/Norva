---
content_id: "NVB-253"
title: "How to Use Categories Inside a Live Program Guide"
seo_title: "Use Categories Inside a Live Program Guide"
meta_description: "Use live guide categories as source-defined discovery facets with a category evidence card that preserves raw labels, scope, combinations, unknowns, and freshness."
slug: "use-categories-in-live-guide"
canonical_url: "https://norva.tv/blog/use-categories-in-live-guide/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should categories be used inside a live program guide?"
supporting_questions:
  - "Why can category labels vary between sources?"
  - "How should multiple filters and uncategorized events be handled?"
audience:
  - "Viewers browsing live programs by subject"
  - "Norva users interpreting guide filters"
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
excerpt: "A category evidence card turns guide facets into transparent discovery aids rather than universal claims about every program."
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
  - "/blog/search-within-live-guide/"
  - "/blog/compare-current-upcoming-programs/"
  - "/blog/spot-stale-program-descriptions/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://dvb.org/metadata/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "live-guide category evidence card"
  summary: "The card records raw and normalized category, source, service, event, time scope, filter logic, uncategorized state, and freshness."
  methodology: "Readers preserve source labels, test one facet at a time, verify AND or OR combinations, inspect uncategorized events, and qualify results by schedule coverage."
  asset_urls: []
---

# How to Use Categories Inside a Live Program Guide

> **In short:** Treat categories as source-defined discovery labels, not universal facts. Preserve the raw label, identify the event and source, test one category at a time, and learn whether combined filters use AND or OR logic. Always inspect uncategorized events and guide coverage before concluding that no matching program exists.

Categories can turn a long schedule into a useful shortlist, but “News,” “Film,” “Kids,” or “Sports” may be assigned differently across sources. One event may carry several labels, a broad label, or none at all.

## Fill in the category evidence card

| Field | Entry |
|---|---|
| Raw source category |  |
| Normalized display category |  |
| Service and event identity |  |
| Time window and zone |  |
| Other active categories |  |
| Combination logic | AND / OR / unknown |
| Uncategorized included? |  |
| Source refresh time |  |
| Result count |  |

The raw and normalized labels belong in different fields. Normalization should improve browsing without erasing source evidence.

## Start with one facet

Choose a category that describes the viewing intent, apply it alone, and note the before-and-after result count. Check several returned events to see what the source label actually covers. A broad “Entertainment” category may include formats that another source separates.

DVB metadata work includes program-description concepts, while DCMI terms distinguish subjects, types, titles, and identifiers. Those distinctions support using categories as descriptive fields rather than identity.

## Test combined filters

When two categories are selected, determine the logic:

- **AND:** an event must carry both labels.
- **OR:** an event can carry either label.
- **Hierarchical:** selecting a parent includes child labels.
- **Exclusive:** choosing a new category replaces the old one.

Use a known event as a control. Do not infer logic from button color alone. Clear all filters between tests so inherited state does not contaminate the result.

## Keep time and service visible

A category result is still a scheduled event. Show service, full start date and time, duration, and episode or edition data. Choose whether you need current or upcoming programs with [the guide-view decision workflow](/blog/compare-current-upcoming-programs/).

Regional service variants may use different category metadata. Compare like with like.

## Handle uncategorized and multi-category events

An uncategorized event is not content-free; it lacks a usable category in the current data. Preserve an “All” or “Uncategorized” route where the interface supports it. Do not force a label from the title or image.

For multi-category events, keep all supplied labels and disclose how the UI chooses the displayed badge. One primary badge should not delete secondary classification evidence.

## Use categories with search

Start with category browsing when the title is unknown. Add text search only after confirming the category result. [The program-guide search ladder](/blog/search-within-live-guide/) shows how to change one constraint at a time.

If an expected event disappears when a category is applied, clear the filter, find the event by identity, and inspect its raw category. That distinguishes a classification mismatch from a missing event.

## Check descriptive freshness

Schedule timing can update while category or synopsis metadata remains old. Compare event identifier, title, revision, and neighboring fields. Use [the stale-description diagnostic](/blog/spot-stale-program-descriptions/) when the category conflicts with the current episode details.

Norva can present categories supplied by compatible sources a user is authorized to access, subject to current product behavior. The source determines classification coverage; the interface should not promise that every event has a complete or consistent label.

## Design a reusable category shortlist

Record the intent rather than permanently saving every returned event. For example: “Family-friendly programs currently scheduled between 18:00 and 20:00 on two verified services.” This definition can be rerun against current data without treating yesterday’s results as permanent.

## Common mistakes and limitations

- Treating categories as stable identifiers.
- Combining filters without knowing their logic.
- Excluding uncategorized events silently.
- Normalizing away meaningful distinctions.
- Ignoring service, time window, and freshness.
- Inferring category from artwork alone.

## Frequently asked questions

### Why can one program have several categories?

Classification serves multiple discovery purposes. Preserve the source labels and let the user choose the relevant facet.

### Does “All” mean every possible event?

It means every event inside the current source, service, time window, and other active constraints.

### Can categories prove suitability for a child?

No. Category, age guidance, synopsis, and household rules are separate inputs.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [DVB Metadata](https://dvb.org/metadata/)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Features](https://norva.tv/#features)
