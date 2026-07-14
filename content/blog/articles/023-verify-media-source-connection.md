---
content_id: "NVB-023"
title: "How to Confirm That a New Source Connected Correctly"
seo_title: "How to Verify a New Media Source Connection"
meta_description: "Verify a new source layer by layer: settings acceptance, catalogue loading, metadata, guide data, playback, and account continuity."
slug: "verify-media-source-connection"
canonical_url: "https://norva.tv/blog/verify-media-source-connection/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Norva Setup & Account"
search_intent: "troubleshooting"
funnel_stage: "retention"
primary_question: "How can I confirm that a newly added source connected correctly?"
supporting_questions:
  - "Which layer should be checked first?"
  - "What does a partial connection mean?"
  - "Which evidence should be preserved?"
audience:
  - "Norva users after adding a source"
  - "People diagnosing partial catalogue loads"
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
  source_of_truth: "https://norva.tv/terms; https://norva.tv/privacy; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "A correct connection is verified in layers: accepted settings, expected sections, one known item, optional guide data, one playback path, and one account action."
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
parent_pillar: "/blog/norva-getting-started/"
related_articles:
- "/blog/connect-compatible-media-source-norva/"
- "/blog/add-check-tv-guide-data-norva/"
- "/blog/video-wont-start-troubleshooting/"
cta:
  label: "Contact Norva support with a redacted example"
  href: "https://norva.tv/support"
  intent: "resolve_setup"
sources:
- "https://norva.tv/terms"
- "https://norva.tv/privacy"
- "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "reproducible six-layer diagnostic matrix"
  summary: "A six-layer matrix separates acceptance, catalogue, metadata, guide, playback, and account state to prevent destructive troubleshooting."
  methodology: "Use one known authorised item, record pass, partial, fail, or not applicable at each layer, and change only the earliest failing layer."
  asset_urls: []
---
# How to Confirm That a New Source Connected Correctly

> **In short:** Verify the connection in layers. First confirm that Norva accepted the settings, then that expected sections and one known item loaded. Check metadata, guide information where relevant, one playback path, and one account action separately. A partial result is useful evidence; it identifies the first layer that needs attention.

Deleting and re-adding a source too quickly destroys the baseline. A structured check is safer and more informative.

## Fast diagnostic

Prepare one known authorised item and mark each layer **pass**, **partial**, **fail**, or **not applicable**:

| Layer | Verification |
| --- | --- |
| Settings | Norva accepts the source or shows a specific error |
| Catalogue | Expected top-level section appears |
| Identity | Known title, year, season, or channel is recognisable |
| Optional guide | Current programme data matches where supplied |
| Playback | One known item begins on the device |
| Account state | Favourite or progress is saved |

Stop at the first failure that blocks later layers.

## Layer 1: settings acceptance

A successful save means only that the input passed the current connection flow. It does not certify every category or item.

If an error appears, record its exact wording, device, app or browser version, and time. Recheck settings against their primary source. Do not publish credentials in evidence.

Return to [How to Connect a Compatible Media Source to Norva](/blog/connect-compatible-media-source-norva/) when the form itself rejects the source.

## Layer 2: catalogue structure

Allow the first load to stabilise. Check whether expected movies, series, or live sections appear.

Interpret outcomes carefully:

- **Nothing appears:** base connection or retrieval may have failed.
- **One section appears:** connection may be partial or the source may not provide others.
- **Categories appear without items:** source data, retrieval, or display may be incomplete.
- **Items appear without artwork:** metadata is incomplete, not necessarily the whole connection.

Do not promise a universal load time.

## Layer 3: known item identity

Search for one reference item selected before setup. Verify title and, where relevant, year, season, episode, duration, or channel identity.

Duplicate-looking versions require closer comparison. Matching artwork alone does not prove identical records.

If the item is absent but other items appear, investigate the source catalogue or category mapping before resetting the account.

## Layer 4: guide information

For live use, compare one known programme’s title, start and end, and device time zone. Guide information is separate from playback.

Use [How to Add and Check TV Guide Data](/blog/add-check-tv-guide-data-norva/) when entries exist but schedule data is missing or shifted.

Mark this layer not applicable when no guide is expected.

## Layer 5: playback

Open the known item, select only source-supplied options, and start briefly.

Record:

- whether playback begins;
- whether audio is present;
- which version was selected;
- whether controls respond;
- whether the problem affects another known item.

If the catalogue works but playback fails, the base connection is not necessarily broken. Device, source, network, media, or format can affect this layer. The planned [video-start troubleshooting guide](/blog/video-wont-start-troubleshooting/) expands that branch.

## Layer 6: account state

Add one favourite or save a short progress point. Return to the library and confirm it appears. On another supported device, check only if cross-device continuity is part of the test.

A failure here concerns account context or item identity, not necessarily source retrieval.

## Build a support-ready record

Include:

- source type without private address;
- device and version;
- account/profile context without personal details;
- date and time;
- first failing layer;
- one known item;
- exact redacted error;
- changes already attempted.

Exclude passwords, usernames, tokens, private links, live pairing codes, and personal history unrelated to the issue.

## What not to do first

Avoid clearing all app data, changing several source values, adding duplicates, reinstalling on every device, or repeatedly applying time offsets.

These actions expand the problem space. Make one reversible change at the earliest failing layer and rerun the same reference check.

## Limitations

A six-layer pass on one item is a baseline, not proof that every item, format, language, or device works. Source data can change.

Norva organises a compatible authorised source; it cannot guarantee completeness of that source.

## Frequently asked questions

### Does missing artwork mean the source failed?

No. If titles load, the connection may work while optional metadata is missing.

### Should I test several devices immediately?

No. Establish one controlled device first, then test cross-device state separately.

### What should I send support?

A redacted record of the first failing layer, known item, device, version, time, and exact error.

## Your next step

[Contact Norva support with a redacted example](https://norva.tv/support)

## Sources

- [Norva Terms of Service](https://norva.tv/terms)
- [Norva Privacy Policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)

