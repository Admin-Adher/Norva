---
content_id: "NVB-302"
title: "How Source-Based Recommendations Support Discovery"
seo_title: "How Source-Based Recommendations Support Discovery"
meta_description: "Learn how source-based recommendations help explore a connected media library, why available titles and metadata shape the result, and how to verify each suggestion."
slug: "source-based-recommendations-explained"
canonical_url: "https://norva.tv/blog/source-based-recommendations-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "educational explainer"
topic_cluster: "Recommendations & Discovery"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How do source-based recommendations support media discovery?"
supporting_questions:
  - "Why does the connected source shape recommendation coverage?"
  - "How should viewers verify a recommended title?"
audience:
  - "Viewers learning how library recommendations work"
  - "Norva users exploring a compatible source"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "Source-based recommendations form paths through the media and metadata already available from a compatible source rather than supplying a separate catalogue."
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
parent_pillar: "/blog/recommendations-discovery-guide/"
related_articles:
  - "/blog/metadata-shapes-related-titles/"
  - "/blog/recommendations-with-incomplete-metadata/"
  - "/blog/evaluate-why-titles-seem-related/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.eidr.org/how-we-work"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source-boundary recommendation map"
  summary: "A four-layer map separates source availability, media identity, descriptive metadata, and viewer decision so coverage limits remain visible."
  methodology: "Readers choose one seed, list visible source and metadata boundaries, inspect five suggestions, and classify relationship evidence without attributing unverified algorithmic logic."
  asset_urls: []
---

# How Source-Based Recommendations Support Discovery

> **In short:** Source-based recommendations help you move from one known title to related items already represented by your connected source. Their coverage depends on what that compatible source contains and how its metadata describes each work. Treat every suggestion as a discovery lead, then verify identity, version, availability, language, subtitles, and relevance before shortlisting it.

This model is useful because it narrows exploration to a library the viewer can actually inspect. It also has a clear boundary: a discovery interface cannot recommend a source item it does not know or repair metadata it never received.

## Separate four layers

| Layer | Question |
|---|---|
| Source availability | Which media records are currently represented? |
| Work identity | Which film, series, season, episode, or version is this? |
| Descriptive metadata | Which creators, subjects, dates, genres, languages, and relations are available? |
| Viewer decision | Does this candidate fit the current discovery brief? |

Confusing these layers leads to false conclusions. A missing suggestion can reflect source coverage or incomplete metadata; an irrelevant suggestion can still be an available work whose visible relationship is too broad for the current brief.

## Understand the source boundary

Norva is software that organises and plays media from a compatible source the user owns or is authorised to use. It does not include a media catalogue in the subscription. Its public features describe recommendations from the connected source.

Therefore, “source-based” should not be rewritten as universal, global, or unlimited. Availability, languages, subtitles, and versions depend on the source and media. Review [the complete discovery guide](/blog/recommendations-discovery-guide/) for the search, browse, and recommendation roles around this boundary.

## See how metadata creates paths

DCMI metadata terms distinguish title, creator, subject, date, type, format, language, and relation. EIDR’s work on media identifiers and hierarchies illustrates the difference between a creative work, series, episode, edit, and manifestation. These fields can support meaningful paths such as same creator, related series, similar subject, or shared period.

The presence of a field does not prove its weight in the current product. Use [the metadata discovery explainer](/blog/metadata-shapes-related-titles/) to observe which relationships are visible without inventing an internal formula.

## Verify each recommendation as a lead

For one candidate, record:

1. the seed title;
2. visible shared attributes;
3. important differences;
4. exact candidate identity;
5. available version and access options;
6. whether it answers the discovery question.

Open the detail surface before playback where possible. A candidate can be related at work level yet unsuitable because the available version lacks the required language or subtitles. Conversely, a surprising candidate can be valuable when one credible relation fits the brief.

Use [the related-title evaluation card](/blog/evaluate-why-titles-seem-related/) when the relationship is not obvious.

## Diagnose coverage gaps carefully

When a known related work is not suggested, search for it directly. If search finds it, compare its metadata with the seed. If it is absent entirely, note source availability rather than blaming recommendation relevance. If it exists but key fields are blank or inconsistent, follow [the incomplete-metadata workflow](/blog/recommendations-with-incomplete-metadata/).

Do not edit dates, creators, or categories merely to force a relationship unless the source’s authorised metadata workflow and evidence support the correction.

## Original evidence: source-boundary map

Choose one seed and five visible suggestions. Build four columns for availability, identity, metadata relationship, and viewer decision. Use “unknown” whenever a field is not visible. Ask another reviewer to explain why each candidate entered or left the shortlist.

The map reveals where evidence ends. It can show that a relation is visible or missing; it cannot identify an internal ranking rule or measure recommendation quality across all libraries.

## Common mistakes and limitations

- Describing source-based suggestions as a separate media catalogue.
- Assuming card order reveals relationship strength.
- Treating absent metadata as a negative attribute.
- Ignoring version and accessibility needs.
- Claiming a particular algorithm or personalisation method without proof.
- Correcting source metadata without authority or evidence.

## Frequently asked questions

### Can a recommendation include an unavailable title?

The visible state depends on current source and product behavior. Verify availability separately and use the unavailable-title workflow when a card cannot be opened.

### Why do two sources produce different discovery paths?

They can contain different works, versions, and metadata. Compare those inputs before comparing the resulting suggestions.

### Does a source-based recommendation guarantee relevance?

No. It is a lead. The viewer still evaluates the visible relationship against a specific discovery brief.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [Norva Features](https://norva.tv/#features)
