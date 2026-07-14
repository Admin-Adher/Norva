---
content_id: "NVB-817"
title: "Encryption in Transit vs. at Rest: What Each Protects"
seo_title: "Encryption in Transit vs. at Rest Explained"
meta_description: "Learn what encryption in transit and at rest protect, where endpoints and keys matter, and how to read qualified security claims for a cross-device media app."
slug: "encryption-in-transit-vs-at-rest"
canonical_url: "https://norva.tv/blog/encryption-in-transit-vs-at-rest/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "security-privacy-explainer"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between encryption in transit and encryption at rest?"
supporting_questions:
  - "Which threats and system boundaries does each measure address?"
  - "How should qualified local-download security claims be read?"
audience:
  - "People evaluating media-app security statements"
  - "Norva users managing connected and offline devices"
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
excerpt: "Transport encryption protects data moving between defined endpoints; storage encryption protects data held on a defined device or system while keys and access controls determine practical protection."
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
  - "/blog/connected-source-data-flow-map/"
  - "/blog/local-media-response-lost-device/"
  - "/blog/media-app-device-security-handbook/"
cta:
  label: "Review Norva's Current Security Statements"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://csrc.nist.gov/pubs/sp/800/111/final"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "encryption boundary and threat matrix"
  summary: "A matrix connects data state, endpoints, storage location, encryption claim, key boundary, unlocked-device access, backups, metadata, and unsupported conclusions."
  methodology: "The analysis quotes only current qualified first-party claims, maps them to one path or storage layer, checks official security guidance, and records unknown algorithms or key handling without invention."
  asset_urls: []
---

# Encryption in Transit vs. at Rest: What Each Protects

> **In short:** Encryption in transit protects data while it moves between defined endpoints; encryption at rest protects data stored on a defined device or system. Neither phrase explains every endpoint, algorithm, key, backup, metadata field, or unlocked-device risk. Map each claim to a path, storage location, key boundary, and threat. Qualifiers such as "where available" matter, and one encrypted category should never be generalized to all application data.

Encryption transforms readable data using a key so unauthorized parties cannot readily interpret it. Its value depends on implementation, key management, endpoint security, and the threat being addressed.

## Transit protection covers a path

HTTPS commonly protects application data between a client and a service endpoint against many forms of interception or modification in transit. The protection begins and ends at defined endpoints; those endpoints may process the readable data.

The [connected-source data-flow map](/blog/connected-source-data-flow-map/) is essential because an account endpoint, configured source host, store, and support system are different paths. A statement about one path does not prove another uses the same controls.

## Routing metadata is a separate question

Encrypted content still travels through networks that require addressing and connection metadata. Network participants may observe different portions of that metadata without seeing the protected application payload.

Do not claim that transport encryption hides every network address, domain, timing signal, or endpoint. It also does not mean that endpoint logs are encrypted at rest.

## At-rest protection covers storage

Storage encryption may protect a device disk, application container, database, backup, or specific media file. Full-disk encryption and per-file encryption address different boundaries. An unlocked device or running application may legitimately decrypt data for use.

NIST guidance on storage encryption emphasizes selecting and managing controls according to the storage environment. A label alone does not reveal algorithms, key location, recovery paths, or administrator access.

## Keys determine practical access

Ask where keys are generated, stored, released, rotated, recovered, and destroyed. Hardware-backed protection can reduce key extraction on supported devices, but availability and behavior depend on hardware, operating system, and implementation.

Norva's current privacy notice states that eligible offline downloads are encrypted on the device and refers to hardware-backed key protection where available. It also states that data is protected in transit using HTTPS. These qualified claims require live human verification.

## Local loss remains a device incident

Encryption can reduce exposure from lost storage, but a weak screen lock, active session, notification preview, shared profile, screenshot, backup, or compromised operating system can create other paths. Follow the [lost-device local-media response](/blog/local-media-response-lost-device/) rather than relying on one control.

The [media-app device security handbook](/blog/media-app-device-security-handbook/) combines updates, screen locks, sign-out, remote device review, and source-account action.

## Password hashing is another concept

Passwords should normally be transformed with a dedicated password-hashing method, not simply encrypted for later recovery. Norva's current notice says passwords are stored hashed by its authentication provider. Do not infer algorithm, cost settings, or database architecture unless current official documentation publishes them.

## Original evidence: encryption boundary and threat matrix

| Data state | Boundary | Claim to verify | Key or endpoint question | Threat addressed | Not proven |
| --- | --- | --- | --- | --- | --- |
| In transit | Device to account endpoint | HTTPS | Where does protection terminate? | Network interception | Endpoint storage security |
| In transit | Device to source | Source-specific | Which configured host? | Path interception | Source retention |
| At rest | Eligible local download | Device encryption | Hardware-backed where available? | Lost storage access | Unlocked-session protection |
| At rest | Service database | Provider-specific | Who controls keys and access? | Stored-data exposure | Every backup uses same layer |
| Password | Authentication system | Hashing | Which provider statement applies? | Recovered plaintext password | All account data encrypted |

## Common mistakes and limitations

- Treating transit and storage encryption as synonyms.
- Assuming HTTPS hides all routing metadata.
- Applying one local-download claim to screenshots or caches.
- Ignoring key management and unlocked-device access.
- Removing qualifiers such as "eligible" or "where available."
- Calling password hashing reversible encryption.
- Presenting encryption as a guarantee against every threat.

## Frequently asked questions

### Does HTTPS mean a provider cannot read the request?

No. HTTPS protects the path to an endpoint; the intended endpoint normally processes the decrypted application data.

### Does device encryption protect an unlocked app session?

Not necessarily. Once authorized software can access data, screen lock, session, operating-system, and application controls remain important.

### Are all Norva files encrypted at rest?

Do not generalize. The current notice specifically describes eligible offline downloads on device; verify other categories separately.

## Your next step

[Review Norva's Current Security Statements](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [NIST: Storage Encryption Technologies for End User Devices](https://csrc.nist.gov/pubs/sp/800/111/final)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
