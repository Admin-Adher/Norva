---
content_id: "NVB-998"
title: "Authentication vs. Authorization in Media Apps"
seo_title: "Authentication vs Authorization in Media Apps"
meta_description: "Learn how authentication differs from authorization across accounts, sessions, devices, profiles, sources, plans, media rights, errors, and audits."
slug: "authentication-vs-authorization-media-apps"
canonical_url: "https://norva.tv/blog/authentication-vs-authorization-media-apps/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "authentication-authorization-concept-comparison"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between authentication and authorization in a media app?"
supporting_questions:
  - "How do accounts, sessions, devices, plans, sources, and media rights create separate boundaries?"
  - "Why can a successfully signed-in user still be unable to perform an action?"
audience:
  - "Media app users"
  - "Norva account and source administrators"
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
  source_of_truth: "https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "Authentication establishes identity or session confidence; authorization determines which action that identity may perform within a defined service or source boundary."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-player-glossary/"
related_articles:
  - "/blog/media-player-glossary/"
  - "/blog/profile-vs-account/"
  - "/blog/pairing-code-vs-password/"
cta:
  label: "Review Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
  - "https://pages.nist.gov/800-63-4/sp800-63b.html"
  - "https://www.rfc-editor.org/rfc/rfc6749"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "identity-permission boundary map"
  summary: "A map separates account authentication, session creation, device approval, profile selection, subscription entitlement, source authorization, media rights, and action-level permission."
  methodology: "The user traces one sign-in and one playback attempt across distinct systems, records the decision at each boundary, and avoids treating technical access as legal authorization."
  asset_urls: []
---

# Authentication vs. Authorization in Media Apps

> **In short:** Authentication answers "which account, user, or device is this?" Authorization answers "what may this authenticated identity do here?" Signing in successfully does not guarantee access to every plan capability, source, media item, device action, or legal right. Media apps often cross several independent authentication and authorization boundaries.

The distinction explains why "my password works, but playback does not" is not contradictory. Sign-in can succeed while plan, source, media, device, or action authorization fails.

The [media player glossary](/blog/media-player-glossary/) defines accounts, profiles, sessions, devices, tokens, entitlements, and sources.

## Authentication establishes identity confidence

Authentication can use a password, passkey, one-time factor, existing session, device ceremony, or another supported method. It creates confidence that the claimant controls the relevant account or authenticator.

Authentication strength, session duration, and recovery behavior are service-specific. Never expose credentials in troubleshooting evidence.

## Authorization evaluates permission

After authentication, the system evaluates whether the identity may perform an action on a resource. It can consider account role, subscription entitlement, device status, source access, item availability, rights, region, time, or other policy.

An authenticated request can therefore receive a legitimate denial.

## Profiles are not authentication by default

Selecting a household profile changes viewing context. Unless current official documentation defines a separate lock or identity check, profile selection should not be treated as account authentication.

See [profile versus account](/blog/profile-vs-account/) before using profile labels as access controls.

## Device pairing combines boundaries

A target device can display a temporary code while an authenticated account holder approves the relationship on another screen. The account holder is authenticated; the request authorizes a device relationship. Later, a token or session can represent that approved access.

The [pairing code versus password guide](/blog/pairing-code-vs-password/) explains why the two secrets serve different jobs.

## Subscriptions add entitlement authorization

A signed-in account may have an active, inactive, mismatched, or limited plan entitlement. Payment evidence and service access are related but separate. The current official plan and account state should be checked before assuming a product fault.

Do not infer Norva plan details from an old receipt or profile.

## Connected sources add another relationship

Norva account authentication does not authenticate the user to every external source automatically. The source can have its own credentials, permissions, availability, and legal authorization. Norva users must connect a compatible source they own or are legally authorized to use.

Technical source access is not proof of media rights.

## Media can have item-level conditions

Within an authorized source, a particular item, version, offline workflow, or track can still be unavailable because of rights, source state, device capability, format, or product support. Authorization and technical compatibility are separate even when both surface as a failed action.

Record the exact boundary and message instead of repeatedly signing in.

## Error categories should stay separate

An authentication error may refer to invalid, expired, or insufficient account or session proof. An authorization error may mean the identity is known but the action is not permitted. A source, network, format, or decoder error belongs to another category.

Do not interpret generic user-facing wording beyond the evidence. Use current official support guidance.

## Audit the full chain

Trace one action from account sign-in to profile selection, device session, subscription entitlement, source connection, item selection, and playback. Record pass, fail, or unknown at each boundary. Keep passwords, tokens, source addresses, payment details, and private titles out.

## Original evidence: boundary map

| Boundary | Authentication question | Authorization question | Evidence |
| --- | --- | --- | --- |
| Norva account | Is the account session valid? | May this account use the requested capability? | Official account state |
| Device | Was the device relationship approved? | Is this session still permitted? | Sanitized device record |
| Profile | Which context is selected? | Are profile-specific actions supported? | Visible profile shorthand |
| Subscription | Which account is entitled? | Does the current plan permit the action? | Official plan display |
| Source | Is the source connection valid? | Is use authorized by owner and policy? | Administrator record |
| Media item | Is the item identified? | Is playback allowed and available? | Source baseline and result |

## Common authentication mistakes

- Treating successful sign-in as permission for every action.
- Treating a profile as a separate account.
- Reusing Norva credentials for a source.
- Confusing payment receipt with entitlement.
- Treating technical access as legal rights.
- Sharing tokens or passwords as diagnostic evidence.

## Frequently asked questions

### Why can I sign in but not play an item?

Authentication may have succeeded while plan, source, item, rights, device, format, or technical conditions still prevent playback.

### Is a pairing code an authentication factor?

It participates in a device-authorization ceremony, but the exact security model is implementation-specific. Follow current official guidance and protect the code.

### Does Norva authorize third-party media rights?

No. Users remain responsible for connecting a compatible source they own or are legally authorized to use.

## Your next step

[Review Norva Support](https://norva.tv/support)

## Sources

- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
- [NIST digital identity guidance](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [RFC 6749 OAuth authorization framework](https://www.rfc-editor.org/rfc/rfc6749)
