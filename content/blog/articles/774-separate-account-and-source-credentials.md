---
content_id: "NVB-774"
title: "Keep Account and Source Credentials Properly Separated"
seo_title: "Separate Account and Source Credentials"
meta_description: "Separate Norva, recovery email, device-platform, password-manager, and authorized-source credentials to limit reuse, confusion, and incident spread."
slug: "separate-account-and-source-credentials"
canonical_url: "https://norva.tv/blog/separate-account-and-source-credentials/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "credential-architecture-guide"
topic_cluster: "Account Security"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should media-account and source credentials be separated?"
supporting_questions:
  - "Which credentials belong to distinct security boundaries?"
  - "How does separation improve incident response?"
audience:
  - "Norva account owners connecting compatible authorized sources"
  - "Households organizing media credentials safely"
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
excerpt: "Credential separation gives Norva, recovery, device platforms, password management, and each authorized source a unique secret, owner, and official destination."
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
parent_pillar: "/blog/media-player-security-checklist/"
related_articles:
  - "/blog/unique-password-lifecycle-media-account/"
  - "/blog/password-manager-setup-media-household/"
  - "/blog/credential-exposure-incident-plan/"
cta:
  label: "Review Norva's Privacy Information"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
  - "https://www.nist.gov/cybersecurity-and-privacy/how-do-i-create-good-password"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "credential boundary map"
  summary: "A boundary map assigns each account a unique password record, owner, recovery route, official destination, sharing rule, and incident action without storing secret values."
  methodology: "The household inventories accounts by function, verifies destinations from official documentation, removes password reuse, and tests whether each boundary can be recovered and contained independently."
  asset_urls: []
---

# Keep Account and Source Credentials Properly Separated

> **In short:** Treat the Norva account, recovery email, device platform, password manager, and every compatible authorized source as separate security boundaries. Give each account a unique password, its own official sign-in destination, a named owner, and an appropriate recovery route. Never paste source credentials into support or reuse them for Norva. Document relationships without recording secrets, then test that one compromised account can be changed independently.

Credential separation is more than using several passwords. It prevents one copied secret, fake sign-in page, shared message, or support mistake from automatically exposing every service in the viewing setup.

## Map the boundaries before changing anything

Create one row for each function:

- Norva account;
- recovery email;
- password manager;
- phone, television, or device-platform account;
- each compatible source the household owns or is authorized to use;
- network or router administration, when relevant to the household.

Norva organizes and plays media from compatible sources; it is not the source of that media. The account owner must follow current terms and keep source authorization valid. This functional distinction should also appear in the credential map.

## Give each boundary a unique secret

Do not create a pattern such as one base password plus a service name. Use a trusted password manager to generate and store a unique value for each account, following the current rules of that service.

The [unique-password lifecycle guide](/blog/unique-password-lifecycle-media-account/) covers creation, recovery, rotation after exposure, and retirement. The [household password-manager guide](/blog/password-manager-setup-media-household/) explains how to organize records without giving every viewer access to every administrative account.

Never put secret values in the boundary map. Record only the vault record name or another non-sensitive reference.

## Pair every credential with its official destination

A unique password still fails if it is entered on a lookalike page. Save the known official sign-in or recovery destination in the password-manager record and navigate independently of unsolicited messages.

Norva credentials belong only at Norva's official routes. Authorized-source credentials belong only at that source's official route or an explicitly documented compatible connection flow. A support agent does not need the actual password, recovery code, one-time code, or live reset link.

## Separate ownership and recovery

Name the person responsible for each boundary and a backup who knows the official recovery process. The owner of an authorized source may differ from the Norva account owner. Make that relationship explicit so an incident does not trigger contradictory changes.

Recovery email is a dependency, not a spare password. Protect it with a unique credential and review its recovery methods, devices, sessions, and forwarding under current provider guidance. If every account recovers through one inbox, record that dependency and prioritize it during response.

## Contain incidents one boundary at a time

When a secret may be exposed, identify whether it belongs to Norva, a source, email, device platform, or password manager. Change it through that service's official destination from a known-good device.

Then check for reuse. If the same old value was used elsewhere, those services are independently affected and need unique replacements. Use the [credential-exposure incident plan](/blog/credential-exposure-incident-plan/) to coordinate recovery, device and session reviews, evidence, and confirmed closure.

A Norva password change does not prove that a source credential changed, and a source password change does not prove that Norva sessions ended. Verify each intended outcome in the relevant official account controls.

## Review sharing and retirement

Give viewers the least access their role requires. Revoke credential sharing when a guest, household member, device, or source relationship ends. Remove retired vault records only after confirming that recovery and records-retention needs are satisfied.

Recheck the map after migrations, email changes, device replacements, source changes, or incidents. Product interfaces and recovery options can change, so current official documentation outranks an old household note.

## Original evidence: credential boundary map

| Boundary | Owner | Vault reference | Official destination | Recovery dependency | Shared with | Incident action |
| --- | --- | --- | --- | --- | --- | --- |
| Norva |  |  | norva.tv route |  |  | Change and review |
| Recovery email |  |  | Provider route |  |  | Secure first if exposed |
| Authorized source |  |  | Source route |  |  | Change independently |
| Device platform |  |  | Platform route |  |  | Review devices and sessions |

The map documents relationships and owners, never passwords, tokens, codes, or live links.

## Common mistakes and limitations

- Reusing one password across Norva, email, and sources.
- Storing several accounts in one ambiguous vault record.
- Entering a source credential into a support conversation.
- Treating recovery email as outside the security design.
- Assuming one service's password change affects another service.
- Giving every viewer administrative vault access.
- Keeping obsolete destinations without rechecking official guidance.

## Frequently asked questions

### Can Norva and a source use the same password?

They should have unique passwords. Reuse turns exposure of one service into a risk for the other.

### Should a support ticket contain source credentials?

No. Describe the boundary and error without sharing passwords, codes, tokens, live reset links, or private source credentials.

### What belongs in the boundary map?

Record owners, official destinations, vault references, recovery dependencies, sharing rules, and incident actions—but never the secrets themselves.

## Your next step

[Review Norva's Privacy Information](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
- [NIST: How do I create a good password?](https://www.nist.gov/cybersecurity-and-privacy/how-do-i-create-good-password)

