---
content_id: "NVB-144"
title: "How to Diagnose Posters Attached to the Wrong Title"
seo_title: "Diagnose Posters Attached to the Wrong Media Title"
meta_description: "Diagnose a wrong poster by confirming record identity, poster provenance, source mapping, cache scope, version and series relationships, then testing one correction."
slug: "diagnose-mismatched-posters"
canonical_url: "https://norva.tv/blog/diagnose-mismatched-posters/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How do I diagnose a poster attached to the wrong media title?"
supporting_questions:
  - "How can an identity mismatch be separated from a cache or grouping issue?"
  - "Which evidence should be collected before replacing artwork?"
audience:
  - "People troubleshooting incorrect catalogue artwork"
  - "Catalogue maintainers investigating media identity mismatches"
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
excerpt: "A wrong poster can reveal a deeper identity, source, version, series, or cache problem, so confirm the record before replacing the image."
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
  - "/blog/resolve-conflicting-release-years/"
  - "/blog/review-old-version-groups/"
  - "/blog/media-metadata-quality-audit/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "poster identity triangulation card"
  summary: "A diagnostic card compares the visible poster, record identity, source reference, related fields, grouping, affected views, provenance, and refresh timing."
  methodology: "Readers reproduce the mismatch, triangulate identity using several independent clues, classify the failure layer, and correct one cause before refreshing and retesting."
  asset_urls: []
---

# How to Diagnose Posters Attached to the Wrong Title

> **In short:** Do not replace the image first. Reproduce the mismatch, confirm the underlying record using several identity clues, determine whether the wrong poster originates in source metadata, a bad work match, a version or episode relationship, a local override, or stale presentation data, then correct one layer and retest. A poster mismatch may be evidence of a deeper catalogue problem.

Artwork is prominent, so it is often the first defect noticed. But the image may be wrong while the record is right—or it may accurately reveal that the whole record matched the wrong work.

## Capture the mismatch before changing it

Record:

- displayed title, year, source, and version label;
- expected work and actual poster subject;
- page or browse route;
- profile, supported device, and time;
- whether the detail page and card disagree;
- whether every grouped version shows the same poster;
- recent import, migration, rename, or refresh activity.

Check another supported view after a normal refresh. If only one view is affected, presentation state becomes a stronger hypothesis; if all views agree, investigate the record and source mapping first.

## Use the poster identity triangulation card

Compare at least three independent clues:

| Layer | Evidence to compare | Result |
|---|---|---|
| Work identity | Creators, cast, synopsis, runtime, year |  |
| Record identity | Stable source reference, edition, series placement |  |
| Poster provenance | Source URL or asset reference, override, update time |  |
| Relationships | Version group, season, episode, parent record |  |
| Presentation | Card, details, search, second supported view |  |

Do not use the title and poster as two independent clues if both came from the same incorrect match. Dublin Core terms such as identifier, title, relation, and source illustrate why identity and provenance should be checked separately.

## Classify the failure layer

Use one of these diagnostic classes:

1. **Source artwork defect:** the connected record supplies the wrong poster.
2. **Identity match defect:** title, year, or identifier matched another work.
3. **Relationship defect:** a version, season, episode, or series inherited artwork from the wrong parent.
4. **Override defect:** a manual or mapping override points to the wrong asset.
5. **Presentation-state defect:** underlying metadata is correct, but one view shows an older image.
6. **Unresolved:** evidence conflicts or provenance is unavailable.

Classification determines the correction. Replacing artwork will not fix a wrong identity match and may hide it.

## Follow a branching diagnosis

If synopsis, cast, runtime, and source reference also describe the wrong work, investigate identity. Use [the conflicting-year workflow](/blog/resolve-conflicting-release-years/) when similar titles depend on dates.

If only one version or episode is affected, inspect parent and group relationships with [the version-group review](/blog/review-old-version-groups/). If the source reference and all descriptive fields are correct but one device differs, follow current support refresh guidance without repeatedly clearing unrelated data.

If the source itself supplies the wrong asset, document it and use an authorised correction route where supported. Keep the original provenance and avoid importing artwork without appropriate rights.

## Correct one variable in a pilot

Capture the baseline and rollback route. Apply one supported change—identity mapping, relationship, source correction, or artwork override—then:

1. refresh normally;
2. compare card and detail views;
3. search by title and year;
4. open grouped versions or neighbouring episodes;
5. check another supported device;
6. wait through the relevant source refresh;
7. confirm the correction persists.

Add the defect to [the metadata quality audit](/blog/media-metadata-quality-audit/) if its cause may affect other records. Search for records sharing the same bad mapping or asset reference rather than correcting only the reported poster.

Norva can organise metadata from compatible authorised sources, but artwork availability, provenance, and refresh behaviour may depend on those sources.

## Common mistakes and limitations

- Choosing new artwork before confirming identity.
- Matching on title alone.
- Assuming every version should use different art.
- Repeatedly refreshing without recording results.
- Ignoring episode and parent relationships.
- Using artwork with unclear rights or provenance.

A visual comparison cannot prove which source layer is responsible. Preserve identifiers, times, and view-specific evidence for support or source investigation.

## Frequently asked questions

### Why does only the card show the wrong poster?

The card and detail view may use different cached, mapped, or sized assets. Record both and follow the supported refresh path before changing identity metadata.

### Should every episode have unique artwork?

Not necessarily. Some sources intentionally use series or season art. The defect is an incorrect relationship or misleading image, not the absence of unique art by itself.

### Can a poster mismatch affect playback?

The image alone may not, but a shared wrong identity or relationship can lead to the wrong record. Test the underlying item rather than assuming the problem is purely visual.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Library of Congress: Inventory and custody](https://www.loc.gov/programs/digital-collections-management/inventory-and-custody/)
- [Norva Support](https://norva.tv/support)
