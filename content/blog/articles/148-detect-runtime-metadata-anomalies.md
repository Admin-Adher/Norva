---
content_id: "NVB-148"
title: "How Runtime Anomalies Reveal Metadata Problems"
seo_title: "Use Runtime Anomalies to Find Metadata Problems"
meta_description: "Use runtime anomalies as signals for wrong matches, editions, partial imports, episode errors, unit mistakes, and probe failures without assuming one norm."
slug: "detect-runtime-metadata-anomalies"
canonical_url: "https://norva.tv/blog/detect-runtime-metadata-anomalies/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "concept-explainer"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can runtime anomalies reveal media metadata problems?"
supporting_questions:
  - "Which runtime differences are meaningful investigation signals?"
  - "How can real editions and specials be separated from bad metadata?"
audience:
  - "People auditing media metadata"
  - "Catalogue maintainers investigating unusual durations"
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
excerpt: "Runtime outliers are useful clues for identity, edition, import, unit, or relationship problems, but they require contextual evidence before correction."
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
parent_pillar: "/blog/media-metadata-quality-audit/"
related_articles:
  - "/blog/media-metadata-quality-audit/"
  - "/blog/review-old-version-groups/"
  - "/blog/audit-series-episode-numbering/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.archives.gov/records-mgmt/scheduling/inventory-intro"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "peer-group runtime anomaly funnel"
  summary: "A funnel compares raw duration validity, contextual peer groups, robust deviation, identity and edition evidence, source provenance, and playback plausibility."
  methodology: "Readers normalise units, create meaningful peer groups, flag broad and local outliers, investigate causes, and correct only verified metadata or relationships."
  asset_urls: []
---

# How Runtime Anomalies Reveal Metadata Problems

> **In short:** Runtime is a diagnostic signal, not a verdict. First validate units and value plausibility, then compare an item with a meaningful peer group such as other episodes in the same season or versions of the same work. Investigate outliers for wrong identity, edition differences, partial imports, probe failures, credits, specials, or unit conversions. Correct only after another clue confirms the cause.

A three-minute “feature film” and a 300-hour episode deserve review, but smaller differences can be legitimate. Extended editions, regional frame-rate conversions, credits, recaps, and source trimming all affect duration.

## Start with raw value checks

Before statistics, verify:

- the stored unit: seconds, milliseconds, minutes, or formatted time;
- zero, negative, blank, or impossible values;
- decimal and rounding rules;
- whether runtime describes media duration, remaining time, or a source estimate;
- when and how the value was measured;
- whether every version has its own value.

A unit conversion error often creates a distinctive factor difference. Do not “correct” the number until the field definition and source transformation are known.

## Build meaningful peer groups

Compare like with like:

- versions of the same work and edition;
- episodes within one season, excluding specials initially;
- instalments with the same format or source;
- records produced by the same import route;
- known feature, short, trailer, or extra types.

A catalogue-wide average is rarely useful because films, episodes, extras, and specials have different distributions.

## Use the runtime anomaly funnel

Pass each candidate through six gates:

| Gate | Question | Result |
|---|---|---|
| Validity | Is the value present, positive, and in the declared unit? |  |
| Context | Is the peer group genuinely comparable? |  |
| Deviation | Is the difference large relative to this peer group? |  |
| Identity | Does title, year, series, and edition match? |  |
| Provenance | Which source or probe supplied the value? |  |
| Playback plausibility | Does observed duration support the metadata? |  |

Only candidates that survive the funnel become correction work.

## Flag outliers without a rigid universal threshold

For a reasonably consistent peer group, calculate the median duration and each item’s absolute difference from it. The median is less distorted by one extreme value than a mean. You may also compare the difference with the median absolute deviation when enough peers exist.

Use broad thresholds to create an investigation queue, not to auto-delete or overwrite. A special episode may be a valid outlier; a wrong match may sit close to the median by chance.

Small groups need manual comparison. For two versions of one film, focus on edition wording, chapter structure, frame-rate context, credits, and reliable source evidence rather than pretending the sample is statistical.

## Diagnose the cause

Common classes include:

- wrong work or episode matched;
- theatrical, extended, restored, or regional version difference;
- trailer, extra, or special classified as the main work;
- partial or interrupted import;
- source probe failed or read the wrong stream;
- seconds and milliseconds confused;
- missing credits, recap, or black frames;
- stale runtime after media replacement;
- season or episode relationship error.

Record at least one supporting clue beyond runtime. If identity differs, inspect [version groups](/blog/review-old-version-groups/). If the candidate belongs to a series, run [the episode-numbering audit](/blog/audit-series-episode-numbering/).

## Verify before correction

Use authorised source metadata, stable identifiers, edition information, and a brief supported playback check. Record the observed end time and any limitations; player-reported duration can itself be affected by the media container or stream.

Correct the verified source, mapping, relationship, or metadata layer in a small reversible batch. Then rerun the peer-group scan and the real retrieval task. Add systemic causes to [the metadata quality audit](/blog/media-metadata-quality-audit/).

Norva organises compatible authorised sources, while runtime values and probing behaviour may depend on the source and media.

## Common mistakes and limitations

- Comparing every record with one catalogue average.
- Auto-correcting outliers to the median.
- Ignoring units and source transformations.
- Treating every long episode as a special.
- Assuming player duration is always authoritative.
- Using runtime as the only identity clue.

Runtime analysis finds suspicious records, not ground truth. Historical or unusual works may need authoritative external evidence.

## Frequently asked questions

### How much runtime difference is suspicious?

It depends on the peer group and edition context. Use relative deviation to prioritise investigation, then require identity or source evidence before correction.

### Can different frame rates change runtime?

Yes, some transfers can have modest duration differences. Record the technical context rather than assuming one version is truncated.

### Should trailers and extras be excluded?

They should be classified separately when possible. If they appear among main works, that relationship or type mismatch is itself an audit finding.

## Your next step

[See how Norva works](https://norva.tv/#how-it-works)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [National Archives: Introduction to inventory and scheduling](https://www.archives.gov/records-mgmt/scheduling/inventory-intro)
- [Norva: How it works](https://norva.tv/#how-it-works)
