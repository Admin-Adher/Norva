---
content_id: "NVB-876"
title: "Seasons Missing After a Series Import? Build a Gap Map"
seo_title: "Seasons Missing After Import? Build a Gap Map"
meta_description: "Troubleshoot missing seasons after import by mapping source availability, season labels, episode ranges, filters, versions, profile, device, and timing."
slug: "seasons-missing-after-series-import"
canonical_url: "https://norva.tv/blog/seasons-missing-after-series-import/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "series-import-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot missing seasons after import?"
supporting_questions:
  - "Which source, series, season, episode, version, filter, profile, device, and timing facts belong in a gap map?"
  - "How can numbering and availability differences be separated?"
audience:
  - "Norva users missing seasons from an imported series"
  - "Household source administrators"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A season gap map compares current source availability with visible Norva series, season, episode, version, filter, profile, device, and timeline evidence."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/expected-items-missing-after-sync/"
  - "/blog/episode-numbering-mismatch-after-import/"
  - "/blog/artwork-missing-after-import/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "series season gap map"
  summary: "A gap map records the series and source version, source season labels, Norva season labels, first and last episode cues, missing ranges, specials, filters, profile, device, application version, and timeline."
  methodology: "The user confirms seasons at the authorized source, freezes viewing context, maps labels and representative episode boundaries, compares one supported device, and avoids renumbering or repeated imports before support review."
  asset_urls: []
---

# Seasons Missing After a Series Import? Build a Gap Map

> **In short:** Confirm the authorized source currently exposes the expected series version and seasons. Record source and Norva season labels, first and last visible episode cues, specials, year, language or edition, account, profile, filters, grouping, device, application version, and timeline. Map present, absent, renamed, combined, split, or unknown seasons without renumbering source data, repeating the import, or assuming every provider uses the same season structure.

“Season missing” can mean an entire source season is absent, its episodes appear under another label, specials are separated, or a different series version is being viewed. A gap map makes those cases visible. Keep the original series structure unchanged during this comparison.

## Confirm the exact series version

Record title, year, source label, edition or language cues, artwork, and any visible series identifier. Similar titles can represent remakes, regional editions, or alternate source entries. Do not compare seasons until the logical series version is reasonably aligned.

The [missing-item checklist](/blog/expected-items-missing-after-sync/) provides the general identity method.

## Inventory seasons at the source

Through the provider's official authorized route, list only season labels and representative episode boundaries. Record whether specials, extras, pilots, or combined seasons have distinct labels. Avoid exporting complete descriptions or private viewing data.

Source structure is evidence, not a promise that every catalog view will use identical labels.

## Inventory seasons in Norva

Using the expected account and profile, record every visible season label, displayed episode count where available, and first and last episode cues. Note empty seasons and labels such as specials without translating them into an assumed number.

## Freeze filters and grouping

Record enabled sources, availability, category, year, rating, audio, subtitles, search query, sort, and grouping. Remove one visible restriction at a time and return to baseline. A language or availability filter can hide episodes that make a season appear incomplete.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) keeps view controls separate from source and identity evidence.

## Build the gap map

Align source and Norva labels without forcing a one-to-one match. For each row, record source season, Norva season, representative first and last episode, present episode range, and unexplained gaps. Classify present, absent, renamed, combined, split, specials, different version, or unknown.

If numbering rather than membership differs, use the [episode sequence map](/blog/episode-numbering-mismatch-after-import/).

## Preserve the import timeline

Record source confirmation time, import or sync request, visible stages, completion, first season observation, and any retry. Include timezone. Use a published timing range only from current Norva support; otherwise report elapsed observation without inventing a deadline.

## Compare another supported device

Use the same trusted account, profile, source selection, filters, grouping, and series close in time. Record both application versions. A season visible on one device only is a cross-screen observation, not proof of local storage or server behavior.

## Separate artwork and metadata gaps

A season tile with missing artwork is still a visible season. A title in search without a usable series entry is another partial state. Record artwork, text, card, detail route, and episodes separately. The [artwork guide](/blog/artwork-missing-after-import/) handles image-only symptoms.

## Avoid source renumbering first

Changing season or episode numbers, titles, folders, metadata, or source addresses creates a new input and can erase the original comparison. Do not repeat imports, remove the source, or bulk-edit the series before saving the gap map and checking current support guidance.

## Original evidence: series season gap map

| Source season | Norva season | First episode cue | Last episode cue | Classification |
| --- | --- | --- | --- | --- |
|  |  |  |  | Present, absent, renamed, combined, split, unknown |
|  |  |  |  |  |
| Specials or extras |  |  |  |  |

Record separately: profile, sources, filters, grouping, device, application version, and timestamps.

## Common mistakes and limitations

- Comparing different series editions or source versions.
- Assuming every provider numbers specials identically.
- Treating a hidden episode as an absent season.
- Renumbering source metadata before preserving evidence.
- Repeating imports and obscuring the first result.
- Exporting a complete private episode catalog.

## Frequently asked questions

### Does a different season label mean content is missing?

Not necessarily. Compare representative episode membership and visible identity cues before classifying the gap.

### Should I renumber the source seasons?

Not as a first diagnostic step. Preserve the current map and follow source and Norva support guidance.

### What should I send support?

Send the redacted gap map, series version cues, stable view context, device versions, source confirmation, and import timeline without credentials.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
