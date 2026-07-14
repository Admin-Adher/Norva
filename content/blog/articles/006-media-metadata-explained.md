---
content_id: "NVB-006"
title: "Media Metadata Explained: Titles, Posters, Genres, Years, and Ratings"
seo_title: "Media Metadata Explained: Titles, Posters, Genres and More"
meta_description: "Understand the metadata that helps a media player identify, describe, group, filter, and display items—and what to check when fields are wrong."
slug: "media-metadata-explained"
canonical_url: "https://norva.tv/blog/media-metadata-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"

content_type: "educational_explainer"
topic_cluster: "Media Player Fundamentals"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is media metadata, and how do titles, artwork, genres, years, and ratings help organise a library?"
supporting_questions:
  - "Which metadata identifies an item?"
  - "Which fields support browsing?"
  - "How should incorrect metadata be diagnosed?"
audience:
  - "People organising a personal media library"
  - "Readers troubleshooting incorrect catalogue information"

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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/terms; https://schema.org/Movie; https://schema.org/TVSeries"

published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5

excerpt: "Media metadata is descriptive information attached to a media item, such as its title, artwork, year, genre, rating, episode identity, or language information."
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
parent_pillar: "/blog/what-is-personal-media-player/"
related_articles:
- "/blog/tv-guide-data-explained/"
- "/blog/diagnose-duplicate-media-titles/"
- "/blog/media-library-categories/"

cta:
  label: "Explore Norva’s catalogue experience"
  href: "https://norva.tv/#product-preview"
  intent: "continue_learning"

sources:
- "https://norva.tv/#features"
- "https://norva.tv/terms"
- "https://schema.org/Movie"
- "https://schema.org/TVSeries"
proof_assets: []

original_evidence:
  required: true
  status: "present"
  type: "reproducible metadata field audit"
  summary: "A field audit groups metadata by identity, description, navigation, and presentation so errors can be traced without guessing."
  methodology: "Inspect one known item, record each visible field and its supplied value, then classify whether an error affects identity, browsing, or presentation."
  asset_urls: []
---

# Media Metadata Explained: Titles, Posters, Genres, Years, and Ratings

> **In short:** Media metadata is information that describes and identifies an item. Titles, episode numbers, years, genres, ratings, descriptions, artwork, and language details help a player label, group, search, and filter a library. The player can organise compatible metadata, but accuracy and completeness often depend on the connected source.

Metadata is the reason a library can appear as more than a list of unnamed files or live entries. Knowing which field performs which job makes duplicate, missing, or incorrect information easier to diagnose.

## Four jobs metadata performs

### Identity

Identity fields distinguish one item from another. A title alone may be ambiguous, so a year, series name, season number, episode number, or stable source identifier can help establish which work or episode is intended.

### Description

A synopsis, genre, rating, cast information, or duration helps a viewer decide whether an item is relevant. These fields describe the item; they do not prove that it is currently playable.

### Navigation

Categories, genres, years, language labels, and availability fields can power filters and sorting. If these values are inconsistent, the interface may place similar items in different groups.

### Presentation

Posters, backdrops, logos, and thumbnails provide visual recognition. Artwork is useful, but it should not be the only way to identify an item. Text remains important for accessibility and when an image fails.

Schema.org’s Movie and TVSeries vocabularies illustrate how structured properties can describe works on the web. A player’s internal model may differ, but the same principle applies: each field needs a defined meaning.

## Where metadata comes from

In a personal media setup, the compatible source generally supplies the catalogue and its descriptive information. The player retrieves, interprets, groups, and displays those fields. It may also preserve account context such as favourites or progress.

Norva states that it organises the catalogue provided by a compatible source the user is authorised to use. It does not promise that every source contains every field.

Schedule information has its own timing concerns. Read [TV Guide Data Explained](/blog/tv-guide-data-explained/) when the problem concerns live programme times rather than a movie or series record.

## Why titles can look duplicated

Two cards with the same title can represent:

- different works released in different years;
- several versions of one work;
- separate language or quality variants;
- repeated records from the source;
- a series and a related special;
- incorrect or incomplete identity fields.

Do not delete or hide a card based on appearance alone. Open the details, compare year, duration, episode identity, available tracks, and source identifiers where visible. The [duplicate-title diagnostic](/blog/diagnose-duplicate-media-titles/) provides a cautious workflow.

## A field-by-field metadata audit

Choose one item you know well and create four groups:

| Group | Fields to inspect | Observable question |
| --- | --- | --- |
| Identity | title, year, series, season, episode | Is this clearly the intended item? |
| Description | synopsis, genre, rating, duration | Does the information describe the same item? |
| Navigation | category, language, availability | Would filters place it where expected? |
| Presentation | poster, backdrop, thumbnail | Does the image match the text identity? |

Record “present,” “missing,” or “different” rather than filling gaps from memory. Note the connected source, device, and date. If possible, compare the original source record with the player presentation.

This audit does not declare which layer is at fault. It produces a minimal example that can be checked or shared with support without exposing source credentials.

## Correct the right layer

If the source record is wrong, changing only the player display may not survive a refresh. If the source is correct but the player maps fields incorrectly, collect the smallest reproducible case.

Use this order:

1. Verify the item’s identity.
2. Check the source-supplied fields.
3. Refresh once.
4. Compare a second known item.
5. Record the exact mismatch.
6. Contact the responsible service with redacted evidence.

Avoid clearing all data before preserving an example. A broad reset can remove the evidence needed to understand the issue.

## Metadata should support decisions

A catalogue does not need every possible field. It needs enough reliable information to support its intended tasks.

For browsing, title, artwork, year, genre, and a short description may be useful. For a series, season and episode identity are essential. For language-sensitive viewing, available audio and subtitle information matters. For live programmes, schedule times and channel matching matter.

A focused [category system](/blog/media-library-categories/) should use metadata that is consistently populated. A filter built on unreliable fields creates false confidence.

## Common mistakes and limitations

Do not treat ratings as universal; different sources may use different systems. Do not assume artwork ownership or licensing merely because an image appears in a source. Do not infer an unavailable language from a missing label without checking the media.

A player may cache metadata, so a corrected source record might not appear immediately. Follow the documented refresh process rather than repeatedly removing the account.

## Frequently asked questions

### Is metadata the same as the media file?

No. Metadata describes or identifies media. It can be stored with a file, beside it, or supplied separately by a source.

### Can a player fill every missing field?

Do not assume it can. Some products enrich records, while others present only source-supplied information. Verify the current feature documentation.

### Why is the year important when the title is correct?

Different works can share a title. A year can help distinguish them and improve grouping or search relevance.

## Your next step

[Explore Norva’s catalogue experience](https://norva.tv/#product-preview)

## Sources

- [Norva features](https://norva.tv/#features)
- [Norva Terms of Service](https://norva.tv/terms)
- [Schema.org Movie](https://schema.org/Movie)
- [Schema.org TVSeries](https://schema.org/TVSeries)

