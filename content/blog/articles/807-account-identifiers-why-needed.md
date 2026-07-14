---
content_id: "NVB-807"
title: "Why Cross-Device Services Use Account Identifiers"
seo_title: "Why Cross-Device Services Use Account Identifiers"
meta_description: "Learn why cross-device services use account identifiers, how identifiers differ from tokens and labels, and which questions support a careful privacy review."
slug: "account-identifiers-why-needed"
canonical_url: "https://norva.tv/blog/account-identifiers-why-needed/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "data-category-explainer"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Why do cross-device services use account identifiers?"
supporting_questions:
  - "How do account IDs, email addresses, profile IDs, labels, and tokens differ?"
  - "Which privacy questions should be asked about identifiers?"
audience:
  - "People learning how cross-device accounts work"
  - "Norva users reviewing identity-related data"
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
excerpt: "Cross-device systems use different identifiers to connect accounts, profiles, sessions, devices, and synchronized state without making every identifier interchangeable."
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
  - "/blog/device-tokens-explained/"
  - "/blog/usage-data-categories-explained/"
  - "/blog/personal-data-vs-media-data/"
cta:
  label: "Check Norva's Account Data Explanation"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en"
  - "https://pages.nist.gov/800-63-4/sp800-63a.html"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "identifier purpose map"
  summary: "A map distinguishes human-facing, account, profile, session, device, pairing, and source identifiers by purpose and lifecycle."
  methodology: "The map uses current first-party descriptions, avoids guessing token formats, records rotation and deletion questions, and separates identifiers that a user sees from internal references."
  asset_urls: []
---

# Why Cross-Device Services Use Account Identifiers

> **In short:** Cross-device services need a reliable way to associate an authenticated person with the correct account, profiles, entitlements, settings, and synchronized state. They may use several identifiers because an email address, internal account ID, profile ID, device record, and temporary token serve different purposes. Review visibility, persistence, rotation, recipients, and deletion for each identifier instead of treating them as one universal tracking number.

An identifier is a value used to distinguish or associate a record. It may be readable to a person, meaningful only to a system, persistent, temporary, direct, or indirect. This explanation is about data literacy, not a legal classification for every implementation.

## One service can need several identity layers

An email address can support sign-in and communication. An internal account ID can link database records without copying that email into every table. A profile ID can separate household preferences. A session value can keep an authenticated interaction active. A device record can support pairing or trusted-device management.

These layers reduce ambiguity, but each creates different review questions. The [device-token explainer](/blog/device-tokens-explained/) covers the especially overloaded word "token."

## Human-facing names are not system IDs

A display name or device label helps a person recognize a profile or television. It may be editable and non-unique. A stable internal identifier usually should not depend on a label that can change or collide with another label.

Do not place secret information in a device name. The [privacy-safe device-label guide](/blog/privacy-safe-device-labels/) explains why descriptive labels should remain useful without revealing a full name, address, or room occupant.

## Profiles and accounts are different scopes

An account can own subscription status and security settings while profiles hold separate history, progress, favorites, or preferences. A profile identifier helps keep those records apart. That does not automatically reveal who the profile represents; the surrounding data and account relationship matter.

Use the [usage-data categories guide](/blog/usage-data-categories-explained/) to separate profile-linked history, progress, favorites, and preferences rather than calling all of them an account ID.

## Identifiers can still be personal data

An identifier does not need to contain a real name to relate to an identifiable person. Context, linkage, access, and reasonable means of identification matter. The [personal-data versus media-data guide](/blog/personal-data-vs-media-data/) provides a practical way to evaluate those relationships.

Pseudonymous values can reduce exposure in some contexts, but replacing a name with a code is not the same as anonymous data when the code can be linked back.

## Persistence should match purpose

Some identifiers must remain stable across devices so the correct account state can synchronize. Others can be short-lived, rotated, scoped to one device, or invalidated after sign-out. Ask why the value must persist, which systems receive it, and what event ends its validity.

Never infer duration from the shape of a value. A long random string is not necessarily long-lived, and a short code is not necessarily harmless.

## Norva's current description

Norva's privacy notice currently describes account information, usage and preferences, device and pairing information, and entitlement status. It also states that eligible account state can synchronize across supported devices. The exact internal identifier names and formats should not be invented when the notice does not publish them.

Human review should confirm the live policy date and current settings before publication. Product claims in this draft remain unverified.

## Original evidence: identifier purpose map

| Identifier type | Human-readable | Typical purpose | Expected scope | Lifecycle question | Secret? |
| --- | --- | --- | --- | --- | --- |
| Email address | Yes | Sign-in or notices | Account | Can it be changed? | Private, not an authentication secret alone |
| Internal account ID | Usually no | Link account records | Account | What happens at closure? | Do not assume |
| Profile ID | Usually no | Separate profile state | Profile | What happens when profile is removed? | Do not assume |
| Device label | Yes | Human recognition | Device | Is it editable? | No, but keep it non-sensitive |
| Session or device token | No | Authenticated or scoped action | Session or device | When does it rotate or expire? | Treat as sensitive unless documented otherwise |

## Common mistakes and limitations

- Using "identifier" and "password" as synonyms.
- Assuming every identifier is visible to the user.
- Treating pseudonymous data as automatically anonymous.
- Expecting an editable profile name to be the database key.
- Publishing token values in screenshots or support messages.
- Guessing format, lifetime, or recipients from appearance.
- Combining account deletion, profile removal, and sign-out.

## Frequently asked questions

### Why not use the email address everywhere?

Internal IDs can separate system references from a changeable, human-readable contact value and reduce unnecessary duplication, although design details vary.

### Is an account ID a secret?

Not always, but it can still be personal or security-relevant. Follow the provider's guidance and never substitute it for a password or session token.

### Does deleting a profile delete the account identifier?

Not necessarily. Profile removal and account closure are different lifecycle events; check the current product controls and policy.

## Your next step

[Check Norva's Account Data Explanation](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: What is personal data?](https://commission.europa.eu/law/law-topic/data-protection/data-protection-explained_en)
- [NIST: Identity proofing and enrollment](https://pages.nist.gov/800-63-4/sp800-63a.html)

