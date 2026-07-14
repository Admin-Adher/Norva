---
content_id: "NVB-836"
title: "Build a Support Packet for an Account Lockout"
seo_title: "Build an Account Lockout Support Packet"
meta_description: "Document a lockout with masked identifiers, timestamps, device and app versions, exact errors, recovery attempts, billing proof, and a clear support request."
slug: "account-lockout-support-packet"
canonical_url: "https://norva.tv/blog/account-lockout-support-packet/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "support-evidence-guide"
topic_cluster: "Account & Subscription Management"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I document an account lockout without exposing secrets?"
supporting_questions:
  - "Which evidence helps support diagnose access safely?"
  - "Which credentials and financial details must be excluded?"
audience:
  - "Norva users locked out of an account"
  - "Household administrators helping an account owner"
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
estimated_reading_minutes: 8
excerpt: "A safe lockout packet gives support enough dated, structured evidence to distinguish account, device, recovery, and entitlement problems without including reusable secrets."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/media-account-lifecycle-handbook/"
related_articles:
  - "/blog/prepare-account-email-update/"
  - "/blog/duplicate-account-created-next-steps/"
  - "/blog/subscription-status-not-updating/"
cta:
  label: "Open Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "redacted account lockout support packet"
  summary: "A packet contains masked account, last successful access, lockout start, exact error, device, system and app versions, network, automatic time, recovery result, provider, redacted entitlement proof, attempts, and desired outcome."
  methodology: "The owner uses official support, captures facts before changing state, redacts reusable credentials and financial data, avoids repeated recovery attempts, and maintains one timestamped incident timeline."
  asset_urls: []
---

# Build a Support Packet for an Account Lockout

> **In short:** Capture the masked account identifier, last successful access, lockout start, exact message, device model, operating system, application version, network, automatic clock status, and recovery attempts. Add the original billing provider and minimal redacted entitlement evidence only if access status matters. State the desired outcome. Never include passwords, one-time codes, recovery codes, tokens, source credentials, card data, or full receipts, and send the packet only through official Norva support.

A structured packet reduces repeated questions while protecting the very information an attacker could reuse. Collect evidence before resetting multiple systems.

## Secure the recovery channel

Confirm the email account is under the owner's control and protected with a unique password and stronger authentication where supported. If the inbox is compromised, recover it through the email provider before using it for Norva recovery.

CISA recommends unique passwords, multi-factor authentication, phishing awareness, and updates as core protections.

## Build one incident timeline

Record the last successful sign-in, first failed attempt, password or email change, device change, provider purchase, recovery request, and current time with timezone. Use exact dates rather than "yesterday."

Do not keep trying while documenting. Repeated attempts can trigger additional protections or overwrite useful error context.

## Capture the exact failure

Copy the message exactly and note whether failure occurs before sign-in, after a code, during account loading, or only when opening subscription features. A screenshot can help if account identifiers, notifications, and background details are removed.

The [subscription-status guide](/blog/subscription-status-not-updating/) applies when sign-in works but entitlement remains stale.

## Record the technical environment

Include device model, operating-system version, Norva version, browser version if relevant, network type, automatic date and time, and whether another authorized supported device shows the same problem. Do not disable certificate checks, device security, or antivirus controls.

One comparison is useful; broad uncontrolled testing is not.

## Add account context safely

Provide a partially masked account email, approximate creation date, profile count, and whether a recent email change or duplicate account may exist. The [email-update guide](/blog/prepare-account-email-update/) and [duplicate-account guide](/blog/duplicate-account-created-next-steps/) show which facts matter.

Never submit another person's profile details unless necessary and authorized.

## Add billing evidence only when relevant

If the case involves paid access, name the provider, plan label, exact provider status, purchase date, and a redacted confirmation. Remove transaction IDs, card digits, addresses, and store account details beyond a masked identifier.

Billing evidence does not prove account ownership by itself, and support may require another verification process.

## State the desired outcome

Ask for a specific result: restore access to the existing account, clarify the recovery path, identify a duplicate, or reconcile entitlement. Do not ask support to bypass identity checks or reveal internal security controls.

Keep one case reference and add new evidence to the existing thread rather than opening many conflicting tickets.

Before sending, have the account owner perform a redaction pass on every attachment. Crop browser tabs, notification banners, nearby profiles, source names, and financial fields. Then list the files in the packet so support can refer to them unambiguously. Preserve the sent version and case reference in protected storage; do not keep separate unredacted working copies on a shared device.

## Original evidence: redacted account lockout support packet

| Field | Safe content | Exclude |
| --- | --- | --- |
| Account | Masked email | Full identifier in public post |
| Timeline | Dates, timezone, sequence | Codes and link tokens |
| Error | Exact wording, redacted image | Other notifications |
| Device | Model and versions | Device token |
| Recovery | Action and result | Recovery secret |
| Billing | Provider, plan, status | Full receipt or card data |
| Request | Desired outcome | Request to bypass verification |

## Common mistakes and limitations

- Sending a password or one-time code.
- Posting the packet publicly.
- Repeating sign-in or recovery without a timeline.
- Omitting timezone and exact error wording.
- Attaching an unredacted screenshot.
- Using billing proof as the only ownership evidence.
- Opening several support cases for one incident.

## Frequently asked questions

### Should support ever need my password?

No legitimate support packet should contain a password, one-time code, recovery code, session token, or source credential.

### Is a full receipt useful?

Provide only necessary redacted fields such as provider, plan, date, and status; full financial and transaction details create needless exposure.

### What if recovery attempts keep failing?

Stop repeating them, preserve the exact timeline and messages, secure the email account, and use official support.

## Your next step

[Open Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
