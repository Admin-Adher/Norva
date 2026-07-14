---
content_id: "NVB-874"
title: "Favorites Orphaned After a Source Refresh? A Recovery Audit"
seo_title: "Favorites Orphaned After a Source Refresh"
meta_description: "Audit favourites after source identity changes by preserving references and comparing profile, source, version, metadata, grouping, devices, and refresh timing."
slug: "favorites-orphaned-after-source-refresh"
canonical_url: "https://norva.tv/blog/favorites-orphaned-after-source-refresh/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "favorite-identity-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I audit favourites after source identity changes?"
supporting_questions:
  - "Which profile, source, item, version, metadata, grouping, device, and timing cues should be compared?"
  - "How can favorite references be preserved before cleanup?"
audience:
  - "Norva users seeing unusable favorite references"
  - "Households after a source refresh"
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
  source_of_truth: "https://norva.tv/privacy"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "An orphaned-favorite audit preserves the original reference, verifies the profile, and compares source, item, version, metadata, grouping, device, and refresh timeline before cleanup."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/progress-reset-after-item-identity-change/"
  - "/blog/grouped-versions-split-after-refresh/"
  - "/blog/expected-items-missing-after-sync/"
cta:
  label: "Review Norva Privacy"
  href: "https://norva.tv/privacy"
  intent: "retention"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "orphaned favorite identity audit"
  summary: "An audit records profile, original favorite state, source and item cues, visible metadata, current candidate entries, grouping, refresh timeline, device and application versions, and recovery outcome."
  methodology: "The user preserves favorite references, verifies current source availability, searches for matching visible identities with stable filters, compares another device, and avoids deletion until the evidence is reviewed."
  asset_urls: []
---

# Favorites Orphaned After a Source Refresh? A Recovery Audit

> **In short:** Do not delete an unusable favorite first. Confirm the active profile and record the original favorite's visible title code, source, year, media type, season or episode, duration, version, artwork, and last known usable time. Rebuild the refresh timeline, verify current source availability, search for matching visible identities with stable filters and grouping, compare another supported device, and treat recovery as uncertain until verified.

An orphaned favorite is a reference that remains visible or remembered but no longer opens the expected current entry. It may coincide with a source or identity change, yet the relationship must be demonstrated through ordinary interface evidence.

## Preserve the favorite reference

Capture a redacted screenshot or note showing where the favorite appears, its label, artwork state, source label, and any message or disabled control. Do not remove and re-add it before recording the original state. Use neutral sample codes for sensitive titles.

## Confirm the profile

Verify the same Norva account and active profile that created or last used the favorite. Record any recent profile switch, household role change, sign-out, or device reassignment. Favorites visible under another profile are not a reliable comparison.

Norva's current privacy notice should guide descriptions of preference and usage data.

## Verify current source availability

Through the source provider's official authorized route, check whether the logical item remains available and whether its source version, season, episode, or metadata changed. Record time and visible cues without exporting the source catalog.

If the item itself is absent after sync, use the [missing-item checklist](/blog/expected-items-missing-after-sync/).

## Rebuild the refresh timeline

Record the last known usable favorite, source refresh or update, visible sync state, first changed item card, and first failed favorite observation. Add device, application version, and timezone. Timing is relevant but does not prove the refresh caused the orphaned reference.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) separates source, sync, device, and identity layers.

## Compare visible identity cues

Record title, year, media type, source label, season, episode, duration, version, language cues, artwork, and grouping. Search for current candidates using stable filters. Do not assume a same-title candidate is the original favorite identity.

If versions separated, use the [grouped-version audit](/blog/grouped-versions-split-after-refresh/).

## Check grouping and filters

Record source availability, category, year, rating, audio, subtitles, search query, sort, and grouping. Align them before deciding the item vanished. An alternate version can appear separately or remain hidden by a visible control.

## Compare another supported device

Use the same trusted account, profile, source selection, filters, grouping, and sample close in time. Record both application versions. A favorite that works on one device establishes a cross-screen difference but not its internal cause.

## Protect related progress

Check whether the original reference or candidate entry has distinct progress or completion state. Do not play, mark completed, unfavorite, or refavorite several versions while testing. The [progress identity guide](/blog/progress-reset-after-item-identity-change/) protects the before-and-after pair.

## Avoid bulk favorite cleanup

Deleting orphaned references may erase the easiest link to their old visible identity. Preserve the sample, follow current Norva support guidance, and test only the smallest reversible action when directed. Do not promise that a favorite can be reattached or recovered.

## Classify the audit

Use profile mismatch, source no longer exposes item, found under another visible identity, grouping difference, filter difference, device-specific state, favorite works but media does not, removed after documented review, or unknown. Keep the old and candidate identities paired.

## Original evidence: orphaned favorite identity audit

| Field | Original favorite | Current candidate |
| --- | --- | --- |
| Profile and device |  |  |
| Source and title code |  |  |
| Year and media type |  |  |
| Season, episode, duration |  |  |
| Version and artwork |  |  |
| Favorite and progress state |  |  |
| Refresh timeline |  |  |
| Outcome |  |  |

## Common mistakes and limitations

- Deleting the favorite before preserving its identity.
- Comparing different profiles or filter states.
- Matching candidates by title or artwork alone.
- Changing progress while testing versions.
- Assuming a refresh automatically caused the issue.
- Promising recovery without verified product evidence.

## Frequently asked questions

### Should I remove and add the favorite again?

Not before preserving the old reference and comparing current identities. Follow current Norva support guidance for the specific case.

### Does a same-title card represent the old favorite?

Not necessarily. Compare source, year, media type, season, episode, duration, version, and grouping cues.

### Can every orphaned favorite be recovered?

No recovery guarantee should be made. Preserve evidence, identify current candidates, and ask support about the redacted sample.

## Your next step

[Review Norva Privacy](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
- [Norva terms of service](https://norva.tv/terms)
