---
content_id: "NVB-303"
title: "How Metadata Shapes Related-Title Suggestions"
seo_title: "How Metadata Shapes Related-Title Suggestions"
meta_description: "Understand how title, creator, subject, date, type, relation, format, and language metadata can form discovery links, and audit missing or misleading fields safely."
slug: "metadata-shapes-related-titles"
canonical_url: "https://norva.tv/blog/metadata-shapes-related-titles/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "educational explainer"
topic_cluster: "Recommendations & Discovery"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can metadata shape related-title suggestions?"
supporting_questions:
  - "Which metadata fields create useful discovery relationships?"
  - "How do missing and incorrect metadata differ?"
audience:
  - "Viewers curious about related-title discovery"
  - "Library owners reviewing media metadata"
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
excerpt: "A field-by-field model for understanding how descriptive metadata can connect works while version metadata determines whether a candidate is usable."
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
  - "/blog/source-based-recommendations-explained/"
  - "/blog/recommendations-with-incomplete-metadata/"
  - "/blog/evaluate-why-titles-seem-related/"
cta:
  label: "See Norva's Library Experience"
  href: "https://norva.tv/#product-preview"
  intent: "awareness"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.eidr.org/how-we-work"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "seed-to-candidate metadata diff"
  summary: "A visible-field diff records shared, different, missing, and conflicting values across work identity and version readiness."
  methodology: "Readers compare one seed with three candidates, label only source-visible fields, separate work-level relevance from version usability, and avoid editing metadata without evidence."
  asset_urls: []
---

# How Metadata Shapes Related-Title Suggestions

> **In short:** Metadata supplies the labels and relationships a discovery system can use: title, creator, subject, date, media type, series relation, format, and language. Shared work-level fields can make two titles meaningfully related, while version-level fields determine whether a candidate is usable. Missing, incorrect, and merely different metadata require different responses.

Metadata is not a verdict about taste. It is structured evidence that can connect records. The better the identity and descriptive fields represent a library, the more explainable its discovery paths can become.

## Separate work fields from version fields

| Work-level fields | Version-level fields |
|---|---|
| Title and alternate title | Edit or cut |
| Creator or contributor | Duration |
| Subject or genre | Audio language |
| Release context | Subtitle availability |
| Series and episode relation | Format or quality label |
| Media type | Source-specific identifier |

Two items may be related as works but differ substantially as versions. EIDR’s public hierarchy distinguishes works, series, episodes, edits, and manifestations. DCMI terms similarly distinguish identifier, type, relation, format, language, date, creator, and subject.

## Recognise several kinds of relationship

**Descriptive similarity** comes from subjects, genres, periods, or creators. **Structural relation** connects a series, season, episode, adaptation, or other explicit relation. **Version relation** connects editions of one work. **Viewer-defined relevance** asks whether any of those links answers the current discovery brief.

Do not assume the current product weighs every field equally. Norva describes recommendations derived from a connected compatible source, but exact selection logic requires current product evidence.

## Build a visible-field diff

Compare one seed and candidate:

| Field | Seed | Candidate | Status |
|---|---|---|---|
| Work identity |  |  | Shared / different / unknown |
| Creator |  |  |  |
| Subject or genre |  |  |  |
| Date or period |  |  |  |
| Relation |  |  |  |
| Language |  |  |  |
| Version |  |  |  |

The table makes [source-based discovery](/blog/source-based-recommendations-explained/) explainable without claiming access to an internal algorithm. Use only values actually visible or verified from the authorised source.

## Distinguish missing, incorrect, and different

**Missing** means a field has no usable value. **Incorrect** means reliable evidence contradicts the value. **Different** means the candidate genuinely has another creator, period, language, or format. Only the second may justify correction, and only through an authorised metadata process.

Do not fill blanks with assumptions. Follow [the incomplete-metadata diagnosis](/blog/recommendations-with-incomplete-metadata/) to identify which missing field blocks discovery and whether a legitimate source-side correction exists.

## Test whether a relation helps the viewer

A technically shared genre may be too broad. Ask what the relation changes: does it surface a new period, creator, style, or format that fits the brief? Record one sentence: “Candidate B is related through creator and period, but differs in genre, which matches the request to broaden.”

Use [the two-title relationship card](/blog/evaluate-why-titles-seem-related/) when the visible connection is surprising. A transparent weak relation can still be useful; an unexplained card should remain a lead, not a trusted match.

## Check version readiness separately

Before shortlisting, verify that the available version has the needed language, subtitles, episode mapping, device context, and source availability. Wording such as “same work” does not mean “interchangeable playback version.”

Norva organises variants according to its public features. Exact grouping, recommendation, and default-version behavior should be verified in the current build.

## Original evidence: metadata diff

Choose one seed and three candidates. Complete the seven-field diff, then highlight which shared fields explain each suggestion and which version fields affect readiness. Ask another reviewer to identify the strongest and weakest relation from the table alone.

The exercise audits visible evidence in one sample. It does not establish causal weighting, universal metadata quality, or product performance.

## Common mistakes and limitations

- Treating metadata as a prediction of personal taste.
- Mixing a work relationship with version equivalence.
- Calling every blank field incorrect.
- Inventing missing values to improve a path.
- Assuming card order reveals field weighting.
- Ignoring source-specific episode or language data.

## Frequently asked questions

### Which metadata field matters most?

There is no universal answer. The useful field depends on the discovery question and current verified product behavior.

### Can artwork create a recommendation relationship?

Artwork can help recognition, but it is weak identity evidence. Prefer explicit titles, identifiers, creators, dates, and relations.

### Should users correct every missing field?

No. Correct only through an authorised workflow with reliable evidence and a clear discovery or retrieval benefit.

## Your next step

[See Norva's Library Experience](https://norva.tv/#product-preview)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [Norva Features](https://norva.tv/#features)
