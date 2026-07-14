---
content_id: "NVB-851"
title: "Rotate Source Credentials After Suspected Exposure"
seo_title: "Rotate Source Credentials After Exposure"
meta_description: "Respond to source-secret exposure by containing access, rotating with the provider, updating devices, reviewing sessions, and preserving redacted evidence."
slug: "rotate-source-credentials-after-exposure"
canonical_url: "https://norva.tv/blog/rotate-source-credentials-after-exposure/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "credential-incident-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should I do after suspected exposure of source credentials?"
supporting_questions:
  - "How can the credential be rotated without losing incident evidence?"
  - "Which sessions, devices, applications, and recovery channels require review?"
audience:
  - "Norva users responding to source credential exposure"
  - "Household source administrators"
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
excerpt: "Credential rotation is an incident sequence: preserve minimal evidence, contain access, change the secret at the source, revoke sessions, update trusted clients, verify, and review the exposure path."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/collect-source-details-securely/"
  - "/blog/credential-entry-error-without-exposure/"
  - "/blog/source-connection-maintenance-audit/"
  - "/blog/household-admin-source-handoff/"
cta:
  label: "Use Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "security"
sources:
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source credential exposure response log"
  summary: "A log records detection, suspected exposure path, affected account, source owner, containment, rotation time, session revocation, recovery review, Norva update, device verification, anomalies, notifications, and closure."
  methodology: "The administrator preserves only non-secret evidence, rotates at the authoritative source, revokes access where supported, updates one trusted client at a time, verifies behavior, and never records the old or new credential."
  asset_urls: []
---

# Rotate Source Credentials After Suspected Exposure

> **In short:** Treat a source password, token, or recovery secret seen by an unauthorized person as an incident. Preserve the time and exposure path without copying the secret, then use the source provider's official account to rotate or revoke it. Review sessions, recovery, and authorized users; update Norva only on trusted devices; verify access and catalog state; remove temporary copies; monitor for anomalies; and document closure without storing old or new credentials.

Rotation replaces or revokes an access secret. It should contain the suspected exposure while preserving enough evidence to understand what happened.

## Confirm ownership and incident scope

Identify the source owner, affected account, credential type, approximate exposure time, devices, people, screenshots, chats, logs, or password-manager shares involved. Do not reproduce the secret in the incident note.

If the account is not yours to administer, contact the authorized owner immediately.

## Preserve minimal evidence first

Record where the credential appeared, who could access that location, how long it may have been visible, and whether suspicious activity is observed. Preserve a redacted screenshot only when necessary.

Do not delay urgent containment to create a perfect report.

## Rotate at the authoritative source

Open the source provider directly from a trusted device. Change the password, revoke the token, or follow its credential-specific recovery flow. Do not change the Norva password unless it was also exposed or reused.

The [secure details guide](/blog/collect-source-details-securely/) keeps the replacement in protected storage.

## Revoke sessions and review recovery

Use source-provider controls to sign out sessions, remove unknown devices, revoke application passwords or tokens, and review recovery email, phone, or stronger authentication where available. Exact controls vary, so follow current provider guidance.

CISA recommends unique passwords, multi-factor authentication, phishing awareness, and software updates.

## Update Norva on trusted devices

Enter the replacement through the current official source settings without putting it in a note, screenshot, or shared clipboard. Update one trusted device or account flow at a time and verify the expected propagation behavior rather than assuming it.

If entry fails, use the [credential-error guide](/blog/credential-entry-error-without-exposure/) without reverting to the exposed secret.

## Check catalog and playback continuity

Confirm the privacy-safe source label, expected categories, a small catalog sample, authorized playback, audio and subtitles where available, and progress state. Do not run a complete catalog export during an incident.

Record any unexpected loss or duplication for later support.

## Remove exposure copies

Delete credential-bearing messages, screenshots, clipboard history, temporary notes, shared password-manager access, browser forms, and support attachments where possible. Remember that deleting one copy may not erase backups or recipients' copies.

Ask recipients to remove the data and confirm without repeating it.

## Monitor and close

Review source sessions, security notices, provider logs where available, account recovery changes, and Norva connection behavior for a risk-appropriate period. The [maintenance audit](/blog/source-connection-maintenance-audit/) provides a later control review.

If administration changes, use the [household handoff guide](/blog/household-admin-source-handoff/) instead of sharing the new secret.

Assign one incident owner and one communication channel. Household members should report observations without testing the exposed value themselves. If financial, employment, or broader account harm is possible, involve the source provider and appropriate qualified assistance. Separate confirmed events from suspicion so later reviewers do not mistake a precautionary rotation for evidence that unauthorized access occurred.

## Original evidence: source credential exposure response log

| Stage | Non-secret evidence | Complete |
| --- | --- | --- |
| Detection | Time and exposure channel |  |
| Scope | Account, credential type, affected devices |  |
| Containment | Provider action and time |  |
| Sessions | Revoked or reviewed |  |
| Recovery | Channels and stronger authentication checked |  |
| Norva update | Trusted entry and result |  |
| Verification | Catalog and playback sample |  |
| Cleanup | Temporary copies removed |  |
| Closure | Anomaly review and owner sign-off |  |

## Common mistakes and limitations

- Copying the exposed secret into the report.
- Changing only the Norva account password.
- Reusing the old credential after rotation.
- Forgetting source sessions and recovery channels.
- Updating many devices simultaneously.
- Sharing the replacement through household chat.
- Assuming deleted messages have no backups.

## Frequently asked questions

### Should I test whether the old credential still works?

Do not keep using an exposed secret. Verify revocation through provider status and the new authorized connection instead.

### Must I change the Norva password too?

Change it if it was exposed, reused, or otherwise at risk; source and Norva credentials should remain separate.

### What should I send support?

Send timestamps, credential type, masked source, exact errors, versions, and actions, never the old or new secret.

## Your next step

[Use Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
