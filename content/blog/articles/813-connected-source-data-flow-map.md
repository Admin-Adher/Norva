---
content_id: "NVB-813"
title: "Map the Data Flow Between an App and a Connected Source"
seo_title: "Map App and Connected Source Data Flows"
meta_description: "Learn to map requests among a media app, account service, connected source, device, store, and delivery provider without merging their separate roles."
slug: "connected-source-data-flow-map"
canonical_url: "https://norva.tv/blog/connected-source-data-flow-map/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "data-flow-guide"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can I map data flows between an application and a connected media source?"
supporting_questions:
  - "Which actors receive account, source, playback, and entitlement requests?"
  - "How do local, synchronized, and external data differ?"
audience:
  - "People evaluating connected media architecture"
  - "Norva users adding compatible authorized sources"
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
  source_of_truth: "https://norva.tv/privacy"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A data-flow map keeps account services, user-selected sources, devices, stores, and infrastructure providers separate before assigning purpose or responsibility."
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
parent_pillar: "/blog/media-player-privacy-basics/"
related_articles:
  - "/blog/data-controller-vs-processor-explained/"
  - "/blog/personal-data-vs-media-data/"
  - "/blog/network-address-data-explained/"
  - "/blog/encryption-in-transit-vs-at-rest/"
cta:
  label: "Compare Norva's Privacy and Service Scope"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.nist.gov/privacy-framework"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "connected-source sequence and boundary map"
  summary: "A sequence table records initiating action, sending component, receiving endpoint, category, purpose, storage outcome, policy owner, and unresolved evidence."
  methodology: "The map begins with observed user actions and first-party statements, separates actors before assigning roles, avoids collecting credentials or live endpoints, and marks undocumented routing as unknown."
  asset_urls: []
---

# Map the Data Flow Between an App and a Connected Source

> **In short:** Start with a user action, then identify the sending component, receiving endpoint, data category, purpose, storage outcome, policy owner, and deletion control. Keep the application operator, compatible source, device platform, application store, and infrastructure providers in separate lanes. A source request initiated inside an app does not make every resulting record app-controlled. Mark undocumented routing as unknown and never expose credentials while testing the flow.

A data-flow map prevents broad assumptions such as "the app has everything" or "the source handles everything." It is a factual model of messages and storage, not a final legal role classification.

## Define the actors first

List the user and device, Norva account service, compatible source selected by the user, application store or payment provider, and named infrastructure processors. Add an actor only when current documentation or direct observation supports it.

The [controller-versus-processor explainer](/blog/data-controller-vs-processor-explained/) shows why an organization can hold different roles for different activities. Do not assign one permanent label to every row.

## Begin each row with an action

Useful actions include creating an account, signing in, adding a source, requesting a catalog, starting playback, saving progress, validating subscription status, pairing a device, downloading eligible media, and closing the account. An action gives the map a start and end.

Do not record passwords, source credentials, tokens, media URLs, or live network addresses. Use neutral names such as "account identifier" and "configured source host."

## Separate account and source requests

Norva describes itself as software that organizes and plays media from a compatible source the user owns or is authorized to use; it does not provide the media itself. Its current privacy notice states that requests for source content go to the host configured by the user.

That means an account-state request and a source-media request can have different destinations. The [network-address guide](/blog/network-address-data-explained/) explains why each destination may observe request metadata independently.

## Distinguish synchronized state from media content

History, progress, favorites, preferences, profiles, and device records can support cross-device continuity. Source responses provide catalog or media information. Eligible offline media can be stored locally under supported conditions. These are different categories and locations.

Use the [personal-data versus media-data guide](/blog/personal-data-vs-media-data/) to avoid assuming that synchronized state is media content or that media-related metadata cannot relate to a person.

## Add store and entitlement flows

A store or payment provider can process a purchase and expose entitlement status to the application. Account closure and subscription cancellation may therefore require separate actions with separate parties. Add both to the map rather than hiding billing behind a single "account" box.

Use only the original provider's current instructions for cancellation, tax, refund, and billing questions.

## Map local storage independently

A device may hold application cache, settings, eligible downloads, screenshots, operating-system logs, or backups. A provider's statement about encrypted eligible downloads does not automatically describe every local artifact.

The [encryption in transit versus at rest guide](/blog/encryption-in-transit-vs-at-rest/) helps attach each security statement to the correct path or storage location.

## Verify with policy and observation

Compare the current privacy notice, terms, device settings, source documentation, store records, and safe network observations. If evidence conflicts, record both versions and the date; do not resolve the difference by guessing.

Never intercept another person's traffic or bypass certificate protections. A consumer review can be useful without invasive testing.

## Original evidence: connected-source sequence and boundary map

| User action | Sender | Receiver | Data category | Immediate purpose | Stored where | Policy owner | Unknown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sign in | App on device | Account endpoint | Account identifier | Authenticate | Service-defined | Norva | Token lifetime |
| Add source | App on device | Service or local configuration | Source setting | Configure authorized source | Policy-defined | Check notice | Exact field set |
| Browse source | App on device | Configured source host | Request and response | Display catalog | Flow-specific | Source and app | Caching behavior |
| Save progress | App on device | Sync endpoint | Usage state | Cross-device continuity | Service-defined | Norva | Update frequency |
| Validate plan | App or service | Store or provider | Entitlement | Confirm access | Provider and service | Both notices | Refresh timing |

## Common mistakes and limitations

- Drawing one box called "cloud" for every provider.
- Mapping data categories without user actions or endpoints.
- Assigning legal roles from brand names alone.
- Recording live credentials in diagrams.
- Treating media content and synchronized progress as identical.
- Assuming uninstall deletes service, source, and store records.
- Extending one encryption claim to every path.

## Frequently asked questions

### Does Norva provide the connected media?

Norva's current terms describe it as player and organizer software; users connect a compatible source they own or are authorized to use.

### Does a source request pass through Norva?

Do not assume. Norva's current notice says content requests go to the configured host; verify current architecture and documentation for the exact flow.

### Is a data-flow map a legal assessment?

No. It documents actors, actions, categories, and evidence; legal roles and obligations require fact-specific qualified analysis.

## Your next step

[Compare Norva's Privacy and Service Scope](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [NIST Privacy Framework](https://www.nist.gov/privacy-framework)

