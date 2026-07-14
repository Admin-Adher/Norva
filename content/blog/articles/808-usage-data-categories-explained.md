---
content_id: "NVB-808"
title: "History, Progress, and Preferences: Usage Data Explained"
seo_title: "Media History, Progress, and Preferences Explained"
meta_description: "Understand how viewing history, progress, favorites, and preferences differ, why they may be synchronized, and how to review their privacy impact."
slug: "usage-data-categories-explained"
canonical_url: "https://norva.tv/blog/usage-data-categories-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "data-category-explainer"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between media history, progress, favorites, and preferences?"
supporting_questions:
  - "Why might these categories synchronize across devices?"
  - "How can a user review the privacy impact of usage data?"
audience:
  - "People reviewing media account data"
  - "Norva users organizing profiles and settings"
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
excerpt: "History, progress, favorites, and preferences are related media-usage categories, but each records a different choice or event and deserves a separate review."
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
  - "/blog/personal-data-vs-media-data/"
  - "/blog/account-identifiers-why-needed/"
  - "/blog/privacy-controls-review-routine/"
  - "/blog/anonymisation-vs-deletion/"
cta:
  label: "Review Norva's Usage Data Description"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en"
  - "https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "usage-state category matrix"
  summary: "A matrix separates observed events, saved positions, explicit selections, inferred settings, profile scope, synchronization, retention, and user controls."
  methodology: "The reader maps only categories named in current first-party documentation, tests each category independently, records uncertain inferences as questions, and dates the review."
  asset_urls: []
---

# History, Progress, and Preferences: Usage Data Explained

> **In short:** History records that media activity occurred; progress records a saved position or completion state; favorites record an explicit saved choice; and preferences store selections such as language or genre settings. These categories can be linked to an account or profile and synchronized for continuity. Review each category's purpose, scope, retention, recipients, controls, and deletion behavior instead of treating all usage data as one undifferentiated log.

Usage data is a broad practical label. Its privacy significance depends on content, linkage, context, precision, retention, access, and the person who can use it. This guide explains categories without making a jurisdiction-specific legal conclusion.

## History answers whether activity occurred

A history entry may record that an item was opened, played, completed, or recently accessed. It can support a recent-items list or help a person return to earlier media. Exact fields and timestamps vary by service, so do not assume a complete event log exists.

History can become revealing when associated with a person or profile. The [personal-data versus media-data guide](/blog/personal-data-vs-media-data/) explains why a title alone and a title linked to an account can require different analysis.

## Progress answers where to continue

Progress usually represents a position, percentage, episode state, or completion marker. It serves continuity rather than simply proving that an item appeared in history. A service might update it during playback, at pauses, or after a threshold; the exact behavior must be verified.

Synchronization can make progress available on supported devices. That convenience also means the state may leave one device and become associated with an account or profile.

## Favorites record an explicit choice

A favorite or saved item is normally a deliberate selection. It may remain until removed, while history could be event-driven. A favorite can be useful for organization even when the item has never been played.

Do not equate a favorite with an endorsement, ownership claim, or completed viewing. The record shows a product action, and interpretation beyond that action may be unreliable.

## Preferences shape future behavior

Preferences may include selected audio or subtitle language, genre choices, sorting behavior, accessibility settings, or profile-level options. Some are explicitly selected; others could be inferred by a service. A policy should make meaningful categories and purposes understandable.

The [account-identifier guide](/blog/account-identifiers-why-needed/) helps determine whether a preference belongs to an account, a profile, a device, or a temporary session.

## Scope matters as much as category

Ask whether the record is local, profile-scoped, account-wide, source-specific, or synchronized. Two profiles in one household should not automatically be assumed to share every history or preference. Likewise, changing a local device option may not change synchronized account state.

Use the [privacy-control review routine](/blog/privacy-controls-review-routine/) to compare application settings, account controls, source settings, device controls, and store settings.

## Retention and removal need separate tests

Removing an item from a visible row, clearing a list, deleting a profile, signing out, uninstalling, and closing an account are distinct actions. A visible interface change does not prove that every related record, backup, aggregate, or external source record was deleted.

Norva's current policy describes history, progress, favorites, and preferences as data used for synchronization and personalization. It also describes deletion or anonymisation at account closure, subject to stated exceptions. Read the live wording and the [anonymisation versus deletion guide](/blog/anonymisation-vs-deletion/) before drawing conclusions.

## Original evidence: usage-state category matrix

| Category | Core question | Typical trigger | Possible scope | Review control | Do not infer |
| --- | --- | --- | --- | --- | --- |
| History | What activity occurred? | Playback or access event | Local, profile, or account | Clear or manage history if offered | Full event telemetry |
| Progress | Where should playback continue? | Position update | Item plus profile | Reset or complete state if offered | Exact update frequency |
| Favorites | What did the user save? | Explicit selection | Profile or account | Add or remove | Ownership or endorsement |
| Preference | How should experience behave? | Setting or learned choice | Device, profile, or account | Settings review | Whether it was inferred |

Add a source date and an "unknown" entry wherever documentation does not answer the row.

## Common mistakes and limitations

- Calling every playback-related record "history."
- Assuming a visible list reveals every stored field.
- Treating favorites as viewing completion.
- Ignoring profile, device, account, and source scope.
- Assuming local removal deletes synchronized or external records.
- Inferring sensitive conclusions from one title or preference.
- Publishing exact behavior without testing the current version.

## Frequently asked questions

### Is progress the same as history?

No. Progress stores continuity state, while history generally records that activity occurred. One product may use both, either, or a combined representation.

### Are preferences always selected manually?

No. Some are explicit settings and others may be inferred. Review the current policy and controls for the service in question.

### Can usage data be personal data?

Yes, when it relates to an identified or identifiable person. Context and linkage matter more than the informal label "media data."

## Your next step

[Review Norva's Usage Data Description](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: What is personal data?](https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en)
- [European Commission: Data-processing principles](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en)

