---
content_id: "NVB-877"
title: "Import Fails After Credential Rotation? Recheck the Connection"
seo_title: "Import Fails After Credential Rotation"
meta_description: "Diagnose import failure after credential changes by confirming rotation, source access, connection details, account scope, device, network, and timeline."
slug: "import-fails-after-credential-rotation"
canonical_url: "https://norva.tv/blog/import-fails-after-credential-rotation/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "post-rotation-import-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I diagnose import failure after source credential changes?"
supporting_questions:
  - "Which rotation, authorization, connection, account, device, network, and timeline facts should be verified?"
  - "How can secrets remain protected during troubleshooting?"
audience:
  - "Norva users after a source credential rotation"
  - "Authorized source administrators"
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
excerpt: "A post-rotation import check verifies that the authorized source accepts the new secret, the protected Norva connection was updated once, and no other context changed."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/rotate-source-credentials-after-exposure/"
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/source-certificate-warning-response/"
  - "/blog/import-sync-support-packet/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "post-rotation connection verification record"
  summary: "A record captures authorization, rotation request and completion, old-session revocation, new-secret source verification, masked Norva connection update, import result, device, network, certificate state, and timestamps."
  methodology: "The authorized owner verifies the new secret at the source, updates the protected Norva connection once, changes no unrelated field, records the first import result, and escalates only redacted evidence."
  asset_urls: []
---

# Import Fails After Credential Rotation? Recheck the Connection

> **In short:** Confirm the authorized source owner completed the rotation and that the new secret works through the provider's official route. Record rotation and revocation times, then update the protected Norva connection once without changing its address, account, profile, or other fields. Capture the first import result, device, application version, network, and certificate state. Never restore an exposed secret or send old or new credentials to support.

A failure after rotation can reflect an incomplete rotation, an outdated connection secret, changed account scope, lockout, endpoint issue, or unrelated import symptom. The sequence must be verified without exposing the replacement credential.

## Confirm authority and incident status

Verify the source owner authorized the rotation and still permits the household connection. If rotation followed suspected exposure, use the [credential exposure response](/blog/rotate-source-credentials-after-exposure/) and preserve incident evidence separately.

Do not reuse the old credential to test convenience. Revoked access should remain revoked.

## Confirm rotation completion

Record when the provider accepted the new secret, when old sessions or tokens were revoked where supported, and who performed each action. Do not put the secret itself in the timeline. A “change requested” message is not necessarily the same as confirmed completion.

## Verify the new secret at the source

Using the provider's current official sign-in or connection route, the authorized owner should confirm the replacement works and the expected account or catalog scope appears. Record success or the exact error, device, network, and timestamp.

If the provider rejects the new secret, resolve that layer before changing Norva repeatedly.

## Compare protected connection fields

In the authorized Norva settings, verify the intended privacy-safe source label, documented address or endpoint, username or account identity, and secret field. Change only the credential value required by current controls. Do not copy it into notes, screenshots, chat, logs, or the support packet.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) separates source access from visible import state.

## Preserve the first post-rotation result

Record the update time, import request, acknowledgment, displayed stage or message, completion result, and last change. Avoid repeated requests. A first exact error is more useful than several mixed attempts after unrelated edits.

## Check account scope and lockout signals

Confirm the rotated credential belongs to the same authorized source account and role. Record any provider message about expiry, lockout, verification, permission, or maintenance. Do not infer that credential syntax or policy caused the result without provider evidence.

## Check network and certificate state

Record the network, source reachability, endpoint identity, and any certificate warning. Never bypass certificate validation. If a warning appears, follow the [certificate response guide](/blog/source-certificate-warning-response/) before entering the new secret.

## Avoid broad resets

Do not remove and re-add the source, clear application data, reinstall, rotate the credential again, change the endpoint, or disable security controls as first steps. These actions create new variables and may erase the clean post-rotation sequence.

## Classify the result

Use rotation not confirmed, replacement rejected at source, source account or scope changed, Norva connection not yet updated, certificate or endpoint warning, import operation did not start, import began but failed, network-specific, or unknown. Keep observed errors separate from suspected causes.

## Escalate without secrets

Send support the masked source label, rotation and update timestamps, provider verification result, exact Norva message, device and application version, network, certificate observation, and actions taken. The [support packet guide](/blog/import-sync-support-packet/) provides the safe structure.

## Original evidence: post-rotation connection verification record

| Check | Observation | Time | Verified by |
| --- | --- | --- | --- |
| Authorization |  |  |  |
| Rotation completed | No secret recorded |  | Source owner |
| Old access revoked |  |  |  |
| New source access |  |  |  |
| Norva connection updated | Masked fields |  |  |
| First import result |  |  |  |
| Network and certificate |  |  |  |

## Common mistakes and limitations

- Restoring or testing an exposed old secret.
- Recording credentials in screenshots or support notes.
- Changing endpoint and credential simultaneously.
- Repeating imports before preserving the first result.
- Bypassing certificate warnings after rotation.
- Assuming timing alone proves the credential caused failure.

## Frequently asked questions

### Can I test the old credential again?

Do not restore a revoked or exposed secret. Verify the replacement through the authorized provider route and follow incident guidance.

### Should I rotate the new secret a second time?

Not before confirming the first rotation, source access, protected Norva update, and exact failure state with the authorized owner.

### What can I share with support?

Share timestamps, masked labels, exact messages, versions, network, certificate state, and verification outcomes—never passwords, tokens, or recovery codes.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
