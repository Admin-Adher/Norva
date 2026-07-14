---
content_id: "NVB-804"
title: "Personal Data vs. Media Data: Know the Difference"
seo_title: "Personal Data vs. Media Data Explained"
meta_description: "Learn how media files, metadata, usage records, account identifiers, device data, and source settings can relate to or identify a person in practice."
slug: "personal-data-vs-media-data"
canonical_url: "https://norva.tv/blog/personal-data-vs-media-data/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "data-category-explainer"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between personal data and media data?"
supporting_questions:
  - "When can titles, progress, preferences, and device records relate to a person?"
  - "How should content, metadata, usage, and source settings be mapped separately?"
audience:
  - "Norva users learning media-data categories"
  - "People reading account and privacy disclosures"
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
excerpt: "Media data is a functional label, not an automatic privacy category: content, metadata, history, progress, preferences, devices, and source settings can relate to identifiable people."
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
  - "/blog/usage-data-categories-explained/"
  - "/blog/connected-source-data-flow-map/"
  - "/blog/media-player-privacy-basics/"
cta:
  label: "Review Norva's Data Categories"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en"
  - "https://www.cnil.fr/fr/donnees-personnelles"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "media-data identifiability matrix"
  summary: "A matrix separates content, metadata, usage, preference, account, device, source, technical, local, and synchronized categories, then records linkage, actor, location, purpose, and sensitivity context."
  methodology: "The reader starts from current policy examples, tests direct and indirect linkage without exposing real history, and marks legal classification as jurisdiction- and fact-dependent."
  asset_urls: []
---

# Personal Data vs. Media Data: Know the Difference

> **In short:** “Media data” describes information about content or playback; it does not mean non-personal. A media file, title, progress point, favorite, subtitle preference, device token, network address, or source setting may relate to an identifiable account or person, alone or when combined. Separate content from metadata, usage, account, device, technical, and source categories, then map who handles each, where it lives, why it is used, and whether linkage can identify someone.

The legal meaning of personal data depends on applicable law and context. This article offers a literacy framework, not an individualized classification or legal opinion.

## Treat “media data” as a practical umbrella

People often use the term for several unlike things:

- the audio or video content itself;
- descriptive metadata such as title, genre, language, or artwork;
- usage events such as history and progress;
- preferences, favorites, and profile choices;
- source settings and connection details;
- technical records about device, version, network, or failure;
- local downloads, screenshots, and exported files.

A useful privacy review never treats that list as one database with one purpose.

## Understand direct and indirect identification

An email address or display name may identify directly. A unique account ID, device token, stable source setting, or combination of timestamps and preferences may link records to an identifiable person or household indirectly.

Whether identification is reasonably possible depends on the data, available additional information, actor, safeguards, and context. Do not declare a dataset anonymous merely because names were removed.

## Separate content from metadata

The content file and its metadata can have different locations and flows. A title and progress point may synchronize while an eligible offline file remains on the device. A source may deliver content while Norva stores continuity data described in its notice.

The [connected-source flow map](/blog/connected-source-data-flow-map/) shows how to record request, destination, response, local handling, and synchronized state without including credentials or private content.

## Map history, progress, and preferences

History answers what was played or opened. Progress marks a position or completion state. Preferences can include audio, subtitles, genre, or display choices. Favorites express a saved selection.

Use the [usage-data category guide](/blog/usage-data-categories-explained/) to distinguish creation event, update frequency, cross-device use, profile linkage, control, and deletion behavior.

## Distinguish account and entitlement data

Account identifiers support sign-in and continuity. Entitlement data can show whether access is active and which store or provider granted it without containing a card number. Payment providers may hold separate transaction information under their own notices.

“No card numbers stored by Norva” should not be rewritten as “no subscription information.” Read the stated entitlement category precisely.

## Distinguish device and technical data

Device model, app version, tokens, pairing records, network address, logs, and crash data may support security, synchronization, delivery, or reliability. They can still relate to an account or device.

Do not assume every log contains viewing history or that no log can contain an identifier. Use the current notice and support response to identify fields and purpose.

## Distinguish source settings from supplied media

A compatible source selected by the account owner is separate from Norva. Connection settings, requests, catalog metadata, and delivered content may involve different actors and terms.

Never copy source credentials into a data map. Record only a neutral source label, category, purpose, and official destination.

## Separate local and synchronized outcomes

Norva's privacy notice says eligible downloads are stored locally, while progress, history, favorites, and preferences can synchronize. A local uninstall and an account deletion therefore answer different lifecycle questions.

Use the [privacy basics canvas](/blog/media-player-privacy-basics/) to connect each category to retention, deletion, anonymisation, and user control without assuming one action affects every location.

## Original evidence: media-data identifiability matrix

| Category | Example | Possible linkage | Location or flow | Purpose | User control | Open question |
| --- | --- | --- | --- | --- | --- | --- |
| Content | Eligible local media | Device or source context | Device / Source | Playback | Local removal |  |
| Metadata | Title or language | Profile or request | Source / App | Organization | Source-specific |  |
| Usage | Progress or history | Account or profile | Synchronized | Continuity | Account settings |  |
| Device | Token or model | Account or hardware | Cloud / Device | Pairing and security | Device review |  |
| Technical | Version or crash event | Device or session | Service logs | Reliability | Support inquiry |  |

## Common mistakes and limitations

- Treating all media-related information as content files.
- Assuming removal of names makes data anonymous.
- Equating “no card number” with “no entitlement data.”
- Combining source and Norva records into one actor.
- Treating local deletion as account deletion.
- Claiming a crash log always includes or excludes history.
- Making a legal classification without context.

## Frequently asked questions

### Is viewing history personal data?

It may relate to an identifiable account or person. The precise legal classification depends on context and applicable rules.

### Is a device token just technical data?

It is technical, but it may also link a device or session to an account; purpose and linkage both matter.

### Does local media remain outside Norva's cloud?

Norva states eligible downloads remain on-device; verify current conditions and distinguish the file from synchronized usage or account state.

## Your next step

[Review Norva's Data Categories](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: What is personal data?](https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en)
- [CNIL: Personal data](https://www.cnil.fr/fr/donnees-personnelles)
