---
content_id: "NVB-984"
title: "Media Source vs. Media Catalog: Know the Difference"
seo_title: "Media Source vs Media Catalog Explained"
meta_description: "Learn how a media source differs from a catalog in ownership, authorization, content delivery, metadata, organization, updates, errors, privacy, and support."
slug: "media-source-vs-media-catalog"
canonical_url: "https://norva.tv/blog/media-source-vs-media-catalog/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "source-catalog-concept-comparison"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between a media source and a media catalog?"
supporting_questions:
  - "Which system supplies media, metadata, organization, and availability?"
  - "How does the distinction improve authorization checks and troubleshooting?"
audience:
  - "Media player users"
  - "Prospective and new Norva users"
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
  source_of_truth: "https://norva.tv/#how-it-works"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "The source supplies authorized media and available metadata; the catalog organizes records for discovery, filtering, grouping, and playback selection."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-player-glossary/"
related_articles:
  - "/blog/media-player-glossary/"
  - "/blog/catalog-import-vs-catalog-sync/"
  - "/blog/evaluate-source-readiness-for-norva/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#features"
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "source-catalog responsibility matrix"
  summary: "A boundary matrix assigns authority, media bytes, metadata, organization, grouping, filters, availability, credentials, update signals, and diagnostic evidence to the appropriate layer."
  methodology: "The comparison follows one authorized item from source administration through catalog presentation and playback while labeling shared or product-dependent responsibilities explicitly."
  asset_urls: []
---

# Media Source vs. Media Catalog: Know the Difference

> **In short:** A media source supplies the media and available source information under an authorization relationship. A media catalog is the organized representation a player presents for browsing, search, grouping, and selection. A successful catalog view does not grant rights, and an absent or incorrect catalog record can originate in source data, import, filters, grouping, or presentation.

This distinction is central to Norva. Norva provides media-player and organizer software; it does not include a media catalog or rights to third-party media. Users connect a compatible source they own or are legally authorized to use.

The [media player glossary](/blog/media-player-glossary/) defines neighboring terms such as import, synchronization, metadata, track, and variant.

## The source supplies media

The source is where the authorized workflow obtains media and related information. Depending on the system, it can expose titles, hierarchy, artwork references, formats, language tracks, availability, and identifiers.

Technical reachability does not prove legal authorization. Record who administers the source and why the account may use it before connection.

## The catalog organizes records

The catalog is what a viewer browses. It can transform source records into movies, series, seasons, episodes, collections, filters, search results, grouped versions, and recommendations derived from source information.

The catalog may cache or index metadata, but that does not make it the source of media rights or guarantee that every displayed item remains playable.

## Metadata crosses the boundary

Source data gives the catalog material to organize. Missing identity, inconsistent season numbers, ambiguous language labels, or incomplete variant details can limit presentation. The organizer may apply its own matching or grouping logic, adding another possible cause.

Record the source baseline and catalog observation separately. "The catalog is wrong" is a conclusion; "source says Season 2, catalog shows Season 1" is useful evidence.

## Availability is not the same as visibility

An item can be visible in the catalog while temporarily unavailable through the source, hidden by an availability state, or unsupported on a particular device. Conversely, an authorized source item may exist but remain absent from the catalog because import or filtering has not exposed it.

Do not use catalog visibility as proof of rights, current availability, or format compatibility.

## Credentials belong to the source boundary

Source addresses, usernames, passwords, and tokens should remain in the intended protected connection workflow. They should not appear in profile names, catalog titles, screenshots, or support notes.

Norva account credentials and source credentials also serve different relationships. Do not reuse or exchange them casually.

## Import connects the layers

Catalog import reads available source information into the organized view. Later synchronization or refresh processes may reconcile changes. See [catalog import versus catalog sync](/blog/catalog-import-vs-catalog-sync/) for the process distinction.

Changing source data and catalog settings simultaneously makes it difficult to identify which layer caused a new result.

## Troubleshoot from source to catalog

For one known item, check the authorized source baseline first: identity, media type, hierarchy, version, tracks, and reachability. Then reset catalog filters and inspect the same fields. Finally, run a controlled playback check.

Use the [source-readiness evaluation](/blog/evaluate-source-readiness-for-norva/) before blaming the catalog for a source-side failure.

## Privacy duties differ by layer

The source administrator controls sensitive connection material and source records. The catalog can expose profile labels, viewing context, titles, artwork, and grouping on shared screens. Review both boundaries, not only the sign-in page.

Support evidence should identify the affected layer without exposing credentials or a complete private catalog.

## Original evidence: responsibility matrix

| Concern | Source | Catalog or organizer | Shared or conditional |
| --- | --- | --- | --- |
| Media delivery | Primary role | Requests supported playback | Device and network affect result |
| Authorization basis | Source owner or administrator | Must not be inferred from visibility | User responsibility and terms |
| Raw metadata | Supplies available fields | Reads and presents fields | Quality affects both |
| Search and filters | May expose native tools | Organizes current catalog | Product-specific |
| Variant grouping | Supplies identity clues | May group source-derived records | Ambiguous data limits confidence |
| Credentials | Protected source workflow | Connection interface only | Never support evidence |
| Playback support | Supplies media | Coordinates player | Format and device-dependent |

## Common boundary mistakes

- Treating catalog visibility as authorization.
- Expecting the organizer to create missing media or tracks.
- Editing source and catalog settings in the same test.
- Reporting a missing item without resetting filters.
- Sharing source credentials as catalog evidence.
- Assuming a metadata error has only one possible layer.

## Frequently asked questions

### Does Norva include media or a catalog?

No. Norva provides media-player and organization software. Users connect a compatible source they own or are legally authorized to use.

### Can a catalog item exist while playback fails?

Yes. Visibility and playback involve different checks. Source availability, media format, device capabilities, network, rights, and current software behavior can affect playback.

### Who should correct bad metadata?

First identify where the discrepancy originates. Preserve the source baseline and catalog observation, then use the appropriate source administration or official product support route.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [How Norva works](https://norva.tv/#how-it-works)
- [Norva features](https://norva.tv/#features)
- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
