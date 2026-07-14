---
content_id: "NVB-991"
title: "Device Token vs. Pairing Code: A Plain-English Guide"
seo_title: "Device Token vs Pairing Code Explained"
meta_description: "Learn how a device token differs from a pairing code in purpose, lifetime, visibility, storage, rotation, revocation, exposure response, and handling."
slug: "device-token-vs-pairing-code"
canonical_url: "https://norva.tv/blog/device-token-vs-pairing-code/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "token-pairing-concept-comparison"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between a device token and a pairing code?"
supporting_questions:
  - "Why is one displayed temporarily while the other should remain machine-held?"
  - "How should users respond to suspected exposure or revoke device access?"
audience:
  - "Media app users"
  - "Norva account administrators"
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
estimated_reading_minutes: 7
excerpt: "A pairing code helps authorize one short device ceremony; a device token is a protected machine credential used after authorization and should never be displayed."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-player-glossary/"
related_articles:
  - "/blog/media-player-glossary/"
  - "/blog/pairing-code-vs-password/"
  - "/blog/trusted-device-vs-signed-in-session/"
cta:
  label: "Review Norva Support"
  href: "https://norva.tv/support"
  intent: "awareness"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
  - "https://www.rfc-editor.org/rfc/rfc8628"
  - "https://pages.nist.gov/800-63-4/sp800-63b.html"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "device-credential lifecycle map"
  summary: "A lifecycle map follows request creation, code display, user approval, token issuance, protected storage, routine use, rotation, revocation, and exposure response."
  methodology: "The guide maps a generic device-authorization pattern, labels Norva implementation details as unverified, and uses no real code, token, account identifier, or endpoint."
  asset_urls: []
---

# Device Token vs. Pairing Code: A Plain-English Guide

> **In short:** A pairing code is a short-lived value used during a specific device-authorization ceremony. A device token is a protected machine credential that software may receive after approval and use for later authenticated requests. Users may need to read and enter a pairing code, but they should never copy, display, or manually manage a device token.

The two values can belong to one flow, which is why they are easily confused. The pairing code helps establish the relationship; the token helps the authorized device operate afterward.

The [media player glossary](/blog/media-player-glossary/) places both beside passwords, sessions, trusted devices, authentication, and authorization.

## The code starts a ceremony

A target device with limited input, such as a television, can display a short code. On another trusted device, the account holder opens the verified approval flow, enters the code, confirms the account and request, and authorizes the relationship.

Do not assume every Norva pairing detail follows a generic standard. Use the current official interface and support guidance.

## The token supports later requests

After approval, software may receive a credential representing the authorized device or session. The token can be used without asking the user to repeat the visible code for every ordinary request.

Its format, scope, lifetime, refresh, and storage are implementation details. Users should not inspect or transfer it.

## Visibility should be opposite

The pairing code may be visible briefly on a controlled target screen because a human must transfer it. The device token should remain invisible inside protected software or operating-system storage.

A support article or representative should not ask a user to paste a raw device token into a message.

## Lifetimes differ

A pairing code should expire quickly and be limited to one request. A token may last longer, rotate, refresh, or be revoked under service rules. Longer life increases the importance of secure storage and revocation.

Do not infer token lifetime from how long the device remains listed in an account interface.

## Storage differs

Never store the pairing code; its value ends with success, cancellation, failure, or expiry. Do not photograph it. The token belongs in application-managed protected storage, not a password note, screenshot, clipboard, or exported log.

Norva-specific storage claims require current official verification. The general safety rule is to avoid exposing machine credentials.

## Exposure response differs

If a live pairing code may have been seen, cancel the request, let the code expire, and begin a fresh official flow after securing the display. Review device records if unauthorized approval may have occurred.

If a device token may be exposed, treat the associated device or session as compromised, use official revocation or sign-out controls, review account activity, and follow verified support guidance.

## Revocation acts on the relationship

Removing a device or ending a session may invalidate one or more tokens according to current product behavior. It does not change the fact that an old pairing code has already expired, nor does it necessarily change the account password.

See [trusted device versus signed-in session](/blog/trusted-device-vs-signed-in-session/) before assuming which layer a removal control affects.

## A password is another separate secret

A password authenticates the account holder, while a pairing code authorizes a particular ceremony and a token represents approved machine access. The [pairing code versus password guide](/blog/pairing-code-vs-password/) explains why reuse and exposure responses differ.

None of these values establishes ownership or legal authorization for media from a connected source.

## Original evidence: credential lifecycle

| Stage | Pairing code | Device token | User action |
| --- | --- | --- | --- |
| Request created | Generated for specific request | Not yet issued | Verify target screen |
| Approval | Human transfers code | Not visible | Confirm account and device |
| Success | Expires or becomes unusable | Issued or activated internally | Verify device record |
| Routine use | Not reused | Used by software | No manual handling |
| Rotation | Not applicable to old code | Product-managed | Follow official prompts |
| Revocation | Cancel pending request | Invalidate relationship or session | Verify result |
| Exposure | Cancel and restart | Revoke and investigate | Use official support |

## Common token and code mistakes

- Photographing a pairing code.
- Asking a user to copy a raw token.
- Treating code expiry as token revocation.
- Saving either value in support evidence.
- Assuming device removal changes the password.
- Believing account access proves media rights.

## Frequently asked questions

### Can I reuse a pairing code after the token is issued?

Do not assume so. The code should be request-specific and short-lived. Follow the current official flow for a new device.

### Where can I view my device token?

Users generally should not need to view it. Use official device and session controls rather than looking for raw credentials.

### Does revoking a device require changing the password?

Not always. The correct response depends on why access is removed and whether account credentials may also be compromised. Follow current official guidance.

## Your next step

[Review Norva Support](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
- [RFC 8628 OAuth device authorization](https://www.rfc-editor.org/rfc/rfc8628)
- [NIST digital identity guidance](https://pages.nist.gov/800-63-4/sp800-63b.html)
