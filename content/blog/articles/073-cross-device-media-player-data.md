---
content_id: "NVB-073"
title: "What Data Does a Cross-Device Media Player Need?"
seo_title: "What Data Does a Cross-Device Media Player Need?"
meta_description: "Map account, source settings, progress, preferences, device, subscription, and technical data to the cross-device functions they support."
slug: "cross-device-media-player-data"
canonical_url: "https://norva.tv/blog/cross-device-media-player-data/"
language: "en"
status: "draft"
robots: "noindex,nofollow"

content_type: "educational_explainer"
topic_cluster: "Privacy, Security & Household Profiles"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Which data categories does a cross-device media player use, and why?"
supporting_questions: ["What does Norva’s Privacy Policy list?", "Which data remains on the device?"]
audience: ["privacy-conscious viewers", "Norva users", "prospective subscribers"]

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
estimated_reading_minutes: 7

excerpt: "A purpose map of the data categories Norva publicly describes for accounts, synchronisation, devices, subscriptions, reliability, and offline use."
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
parent_pillar: "/blog/individual-household-media-profiles/"
related_articles: ["NVB-070", "NVB-074", "NVB-075"]

cta:
  label: "Read the complete Norva Privacy Policy"
  href: "https://norva.tv/privacy"
  intent: "Review current data categories and rights"

sources:
  - "https://norva.tv/privacy"
  - "https://eur-lex.europa.eu/eli/reg/2016/679/art_5/oj/eng"
  - "https://norva.tv/mentions-legales"
proof_assets: []

original_evidence:
  required: true
  status: "present"
  type: "data-to-purpose map"
  summary: "A table mapping each publicly documented Norva data category to its stated service purpose."
  methodology: "Direct synthesis of the public Privacy Policy dated 22 June 2026; no undisclosed data flow is inferred."
  asset_urls: []
---

# What Data Does a Cross-Device Media Player Need?

> **In short:** A cross-device player needs enough information to identify the account, connect the authorised source, remember progress and preferences, recognise paired devices, confirm subscription access, and diagnose failures. Norva’s policy lists these categories and states that offline media remains encrypted on the device. Necessary does not mean unlimited: purpose and data minimisation still matter.

“The app uses data” is too broad to be useful. A better privacy question is: **which category supports which function, who receives it, and how can the user control it?** Norva’s public Privacy Policy, updated 22 June 2026, provides a category-and-purpose table that makes this mapping possible.

## Map each category to a service purpose

This table is the original evidence element for the article. It summarises the public policy without adding hidden flows.

| Data category | Examples described publicly | Stated purpose |
| --- | --- | --- |
| Account | Email, display name, hashed password | Create, secure, and sign in to the account |
| Source settings | Connection details supplied by the user | Connect to the authorised source on the user’s behalf |
| Usage and preferences | History, progress, favourites, language and genre preferences | Resume across devices and personalise the experience |
| Devices and pairing | Trusted-device records, device tokens, pairing codes | Pair screens and synchronise playback |
| Subscription | Status and granting store or provider | Verify access to Norva features |
| Technical | Network address, app version, device model, basic logs and crash data | Deliver requests, secure the service, and fix problems |
| Offline media | Encrypted media stored on the device | Provide offline use where supported |

The policy states that Norva does not store card numbers; payment providers handle transactions. It also states that offline media is not uploaded to Norva.

## Cross-device continuity needs an account reference

To show the same progress or preferences on another supported screen, the service needs a way to associate both devices with the same account context. That is why account identifiers, playback progress, preferences, and trusted-device relationships appear in the policy.

This does not justify collecting unrelated information. The GDPR principle of data minimisation says personal data should be adequate, relevant, and limited to what is necessary for the stated purpose.

The [trusted-device review guide](https://norva.tv/blog/review-trusted-device-list/) turns one of these categories into a practical user check.

## Source settings serve a user-requested connection

Norva is software that organises and plays a compatible source the user is authorised to access. The service uses connection settings to reach that source on the user’s behalf. The user remains responsible for the source and its terms.

Do not describe Norva as including media access, and do not publish source credentials in screenshots, support forums, or article examples.

## Payment status is different from card data

Norva needs to know whether access has been granted and which store or payment provider granted it. The public policy says those providers handle payments and that Norva does not store card numbers.

That is narrower than saying “Norva has no payment data.” Subscription status and provider information are still account data described by the policy.

## Processors and connected services matter

The policy identifies service providers for authentication, cloud database hosting, web delivery, and subscription verification. It also explains that requests go to the media source when the user asks Norva to connect.

Norva states that it does not sell personal information and does not use it for third-party advertising. Do not turn that into “no data is shared”: processors receive data for defined service purposes.

## Offline media follows a different storage model

The public policy says downloaded media is encrypted and stored only on the device, and is not uploaded to Norva. Availability depends on the device, source, and media rights.

Read [how on-device encryption protects offline downloads](https://norva.tv/blog/on-device-encryption-offline-downloads/) for the security model and its limits.

## User control completes the picture

The policy describes access, update, and deletion options. Users can request account deletion in the app or through the Web page. Deletion may involve erasure or anonymisation, with limited retention where legal obligations apply.

The guide to [account deletion and data removal](https://norva.tv/blog/account-deletion-data-removal/) separates cloud account data from local device data.

## Common mistakes and limitations

- Saying a cross-device service needs no account or device data.
- Saying Norva stores no payment-related information when it does retain subscription status and provider.
- Claiming no processors receive data.
- Claiming all data remains in one country; the policy allows international processing with safeguards.
- Treating a privacy-policy summary as legal advice.
- Assuming local offline files and cloud account records follow the same deletion path.

This article reflects the public policy dated 22 June 2026. It must be reviewed when that policy or product behaviour changes.

## Frequently asked questions

### Does Norva sell personal information?

The current Privacy Policy states that Norva does not sell personal information and does not use it for third-party advertising.

### Does Norva store card numbers?

The policy states that payment and store providers handle payments and Norva does not store card numbers. Norva does process subscription status and the granting provider.

### Is every download uploaded to the cloud?

No. The policy states that offline media is encrypted and stored on the device and is not uploaded to Norva.

### Is all data processed only in Europe?

No such promise should be made. The policy states that data may be processed in other countries with appropriate safeguards.

## Your next step

[Read the complete Norva Privacy Policy](https://norva.tv/privacy)

## Sources

- [Norva Privacy Policy](https://norva.tv/privacy)
- [GDPR Article 5: Principles Relating to Processing](https://eur-lex.europa.eu/eli/reg/2016/679/art_5/oj/eng)
- [Norva Legal Notice](https://norva.tv/mentions-legales)

