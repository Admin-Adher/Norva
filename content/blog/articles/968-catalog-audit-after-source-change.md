---
content_id: "NVB-968"
title: "Run a Catalog-Wide Audit After a Source Change"
seo_title: "Catalog Audit After a Source Change"
meta_description: "Audit a media catalog after a source change through scope, counts, identities, categories, series, variants, metadata, tracks, progress, and favorites."
slug: "catalog-audit-after-source-change"
canonical_url: "https://norva.tv/blog/catalog-audit-after-source-change/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "post-source-change-catalog-audit"
topic_cluster: "Media App Maintenance & Audits"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I audit a media catalog after changing a source?"
supporting_questions:
  - "How should counts, identities, categories, series, variants, metadata, tracks, progress, and favorites be sampled?"
  - "How can legitimate source changes be separated from import, mapping, or presentation problems?"
audience:
  - "Users who changed or refreshed a media source"
  - "Household catalog administrators"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 9
excerpt: "A source-change audit compares a saved baseline with counts and identity-based samples across categories, series, variants, metadata, tracks, progress, favorites, and screens."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-app-maintenance-audit-handbook/"
related_articles:
  - "/blog/media-app-maintenance-audit-handbook/"
  - "/blog/baseline-before-second-source/"
  - "/blog/verify-sample-after-source-connection/"
  - "/blog/progress-baseline-after-source-change/"
  - "/blog/post-recovery-import-integrity-audit/"
cta:
  label: "Review Norva Catalog Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "stratified post-source catalog audit sheet"
  summary: "A sheet compares pre-change and post-change scope, counts, known item identities, category membership, series hierarchy, grouped variants, metadata and tracks, progress and favorites, second-device state, and unresolved owner."
  methodology: "The administrator saves a minimal baseline, samples each catalog layer with neutral identifiers, compares the source itself with Norva presentation, classifies expected, regression, unknown, or not applicable, and avoids treating total count as sufficient evidence."
  asset_urls: []
---

# Run a Catalog-Wide Audit After a Source Change

> **In short:** Preserve a pre-change baseline whenever possible, then compare source scope, total and category counts, known item identities, series hierarchy, grouped variants, metadata, audio and subtitle tracks, progress, favorites, and one second supported screen where relevant. Use stratified samples rather than a full private export. Label expected source changes separately from import, mapping, presentation, and user-state differences, and assign unresolved findings.

A source change can alter both the media supplied and the identifiers used to organize it. A catalog-wide audit does not mean manually inspecting every item. It means sampling every important layer so a good total count cannot hide broken identities, seasons, tracks, or user state.

## Preserve the change record

Write the authorized source action, actor, time, previous and new source codes, application versions, profiles, devices, and reason. Keep credentials and private addresses out of the record. If adding a second source, use the [pre-second-source baseline](/blog/baseline-before-second-source/).

Place the audit under the [maintenance handbook](/blog/media-app-maintenance-audit-handbook/).

## Compare scope and counts

Record total visible items and counts for a few representative categories before and after. A difference can be legitimate because source content changes. Counts identify where to sample; they do not prove identity or completeness.

Keep unavailable or hidden filters stable during comparison.

## Sample item identity

Choose ten to twenty neutral sample codes across movies, series, recent items, older items, and known edge cases. Compare source identity, displayed title, year where supplied, category, and availability. Use fewer samples for a small catalog and more only when risk justifies it.

The [post-connection sample guide](/blog/verify-sample-after-source-connection/) provides a smaller initial method.

## Inspect series hierarchy

For two or three known series, compare series identity, seasons, episode sequence, titles, and one playback sample. Missing seasons and numbering differences require a sequence map rather than a count alone.

Do not assume every source uses identical season conventions.

## Check grouped variants

For known multi-version items, record which identities belong together, their source labels, audio and subtitle tracks, runtime, and current grouping. Norva can group variants, but source identity changes may split or regroup them. Classify the evidence before manually editing anything.

Avoid merging merely similar titles.

## Compare metadata and tracks

Sample artwork, description, year, genre, runtime, rating, audio, and subtitles where the source supplies them. Separate absent source data from presentation. Languages and subtitles depend on the source and media.

Do not use a badge alone when an actual track list is available for the item.

## Protect progress and favorites

Before the change, record neutral codes and distinctive progress markers for a small set, plus favorite state. Afterward, compare the same identities. Use the [progress baseline guide](/blog/progress-baseline-after-source-change/) to detect identity-related resets or orphaned favorites.

Do not export detailed household history.

## Compare another supported screen

Where cross-screen use matters, hold account, profile, source, filters, and sample constant. Record application or browser versions and close timestamps. A difference on one device may reflect stale catalog state or presentation rather than source scope.

## Classify and remediate

Use expected source change, missing import, duplicate identity, hierarchy difference, grouping difference, metadata difference, user-state difference, device presentation, unknown, or not applicable. Assign an owner and evidence. Avoid repeat imports, source deletion, or broad resets until the layer is understood.

For a recovered import, use the [integrity audit](/blog/post-recovery-import-integrity-audit/) before closing.

## Original evidence: stratified catalog audit

| Layer | Baseline | Post-change sample | Classification | Evidence | Owner |
| --- | --- | --- | --- | --- | --- |
| Scope and counts |  |  |  |  |  |
| Item identity |  |  |  |  |  |
| Series hierarchy |  |  |  |  |  |
| Grouped variants |  |  |  |  |  |
| Metadata and tracks |  |  |  |  |  |
| Progress and favorites |  |  |  |  |  |
| Second screen |  |  |  |  |  |

## Common mistakes and limitations

- Treating total count as a complete audit.
- Comparing different filters or profiles.
- Exporting a private catalog unnecessarily.
- Assuming all source metadata should remain unchanged.
- Reimporting repeatedly before classifying identities.
- Ignoring progress and favorites.

## Frequently asked questions

### Must every item be checked?

No. Use stratified samples that cover every important layer and expand only where a finding justifies it.

### Does a changed count mean the import failed?

Not necessarily. Source content and availability can change; inspect known identities and scope before classifying the difference.

### Should I remove the source and add it again?

Not as a first step. Preserve evidence, isolate the affected layer, and follow current support guidance before a disruptive change.

## Your next step

[Review Norva Catalog Support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
