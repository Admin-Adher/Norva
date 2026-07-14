---
content_id: "NVB-227"
title: "How to Find Gaps in an Episode Sequence"
seo_title: "Find Gaps in a Series Episode Sequence"
meta_description: "Find episode-sequence gaps with an identifier-first ledger comparing numbering, titles, dates, parentage, specials, aliases, and source availability."
slug: "find-gaps-in-episode-sequence"
canonical_url: "https://norva.tv/blog/find-gaps-in-episode-sequence/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can gaps in an episode sequence be found and diagnosed?"
supporting_questions:
  - "How can a missing episode be separated from alternate numbering?"
  - "What evidence proves a genuine hierarchy gap?"
audience:
  - "People auditing a personal series library"
  - "Norva users troubleshooting missing or misnumbered episodes"
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
excerpt: "An episode sequence audit distinguishes a truly missing child record from alternate numbering, specials, combined episodes, unavailable versions, and source-specific presentation."
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
parent_pillar: "/blog/series-library-workflow-guide/"
related_articles:
  - "/blog/verify-next-episode/"
  - "/blog/place-series-specials-clearly/"
  - "/blog/audit-series-after-source-update/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.fiafnet.org/cataloguing-manual"
  - "https://www.eidr.org/how-we-work"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "episode sequence reconciliation ledger"
  summary: "A ledger compares stable identity, parent, distribution number, alternate number, title, release date, source item, availability, special status, and confidence for every expected slot."
  methodology: "Readers freeze current state, obtain an authoritative sequence, map observed records by identifier before number, classify discrepancies, and test the surrounding next-episode transition."
  asset_urls: []
---

# How to Find Gaps in an Episode Sequence

> **In short:** Freeze the current series, season, source, and profile state; obtain a trusted episode sequence; then map each observed record by stable identifier, title, date, and parent before comparing displayed numbers. Classify every apparent gap as truly missing, unavailable, merged, special, alternate-numbered, wrongly parented, or still unknown. Do not renumber the library until the identity and source mapping are verified.

A jump from episode 5 to 7 is evidence of a discrepancy, not proof that episode 6 is absent. Some sources combine episodes, restart numbering, use production order, separate specials, or omit unavailable items.

## Freeze the audit state

Record:

- series and season identifiers;
- profile and connected-source scope;
- source refresh timestamp or status;
- active search and filters;
- current episode count;
- last completed and next expected episode;
- screenshots or exports where appropriate.

Do this before refreshing or editing. The pre-change state is the comparison baseline.

## Build the reconciliation ledger

| Expected slot | Stable ID | Title | Release date | Parent | Source number | Alternate number | Status | Confidence |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

FIAF cataloguing guidance supports hierarchical episode description and supplied titles or numbers when source information is incomplete. EIDR's public structure likewise separates series, seasons, episodes, and versions. Use identity and parentage before trusting display order.

## Obtain an authoritative expected sequence

Prefer a creator, distributor, broadcaster, registry, or archival source appropriate to the series. Record which numbering scheme it uses: original distribution, production, house, continuous series, or another documented order.

Do not combine schemes into one “correct” list. Keep aliases and map them.

## Map by identity before number

For every observed episode, compare:

- stable identifier;
- exact and alternate titles;
- release date;
- series and season parent;
- runtime;
- adjacent episode clues;
- source version.

Two differently numbered rows may be the same episode. One numbered row may contain two combined episodes. A duplicated title may represent separate parts.

## Classify the discrepancy

Use one of these states:

- **Missing record:** authoritative episode has no mapped record.
- **Unavailable item:** identity exists, but no current authorized version is available.
- **Combined presentation:** one source item contains multiple episodes.
- **Split presentation:** one episode appears as multiple source items.
- **Special:** separate from regular numbering.
- **Alternate numbering:** same identity, different scheme.
- **Wrong parent:** episode mapped to another season or series.
- **Hidden state:** filter or source scope conceals it.
- **Unknown:** evidence is insufficient.

Use [the special placement workflow](/blog/place-series-specials-clearly/) instead of filling a regular gap with a special by assumption.

## Test the surrounding transition

Open the episode before the gap and verify what “next” selects. Then open the episode after the gap and inspect its previous context. Do not play beyond the spoiler boundary when the audit is purely structural.

Record the stable identifiers on both sides of the gap; matching titles alone cannot prove that the transition belongs to one ordering scheme.

[The next-episode preflight](/blog/verify-next-episode/) provides a checksum for this transition.

## Correct the owning layer

If the issue is source metadata, preserve the mapping and report it rather than inventing a local episode. If the issue is a filter, clear the state. If it is wrong parentage, snapshot progress before changing hierarchy and verify the saved next episode afterward.

After a source refresh, use [the post-update series audit](/blog/audit-series-after-source-update/) to compare before and after identifiers, versions, and progress.

Norva may organize series hierarchies and compatible authorized sources, but episode coverage and numbering depend on connected metadata. Support requests should include the ledger, not only a screenshot of the numeric gap.

## Common mistakes and limitations

- Assuming a skipped number proves a missing episode.
- Renumbering before matching identifiers.
- Mixing production and distribution order.
- Ignoring combined or split source items.
- Treating unavailable as nonexistent.
- Refreshing before preserving the baseline.

## Frequently asked questions

### Should episode numbers always be consecutive?

No. Specials, alternate schemes, parts, and source conventions can create valid nonconsecutive displays. Verify the authoritative sequence.

### What if titles and numbers both disagree?

Use stable identifiers, parentage, date, runtime, and reliable external evidence. Mark unresolved mappings unknown.

### Can a gap be caused by filters?

Yes. Check search, availability, source, language, favorites, and hidden profile state before concluding the record is absent.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [FIAF Moving Image Cataloguing Manual](https://www.fiafnet.org/cataloguing-manual)
- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [Norva Support](https://norva.tv/support)
