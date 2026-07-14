---
content_id: "NVB-770"
title: "Create a Response Plan for Exposed Account Credentials"
seo_title: "Response Plan for Exposed Account Credentials"
meta_description: "Respond to exposed media credentials by containing the incident, securing recovery, changing unique passwords, reviewing sessions, separating sources, and logging evidence."
slug: "credential-exposure-incident-plan"
canonical_url: "https://norva.tv/blog/credential-exposure-incident-plan/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "incident-response-guide"
topic_cluster: "Account Security"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I respond to exposed media-account credentials?"
supporting_questions:
  - "Which account should be secured first?"
  - "How can sessions, recovery, and reused credentials be reviewed?"
audience:
  - "Norva account owners responding to credential exposure"
  - "Households preparing a media-account incident plan"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A credential-exposure plan contains the event, protects recovery, changes affected unique secrets, reviews devices and sessions, separates source accounts, and records confirmed outcomes."
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
  - "/blog/secure-recovery-email-media-account/"
  - "/blog/separate-account-and-source-credentials/"
  - "/blog/recognize-media-account-phishing-page/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://www.cisa.gov/secure-our-world"
  - "https://support.google.com/accounts/answer/6294825"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "credential exposure incident ledger"
  summary: "A ledger maps exposed secret, discovery, account dependencies, containment, official password changes, session reviews, device actions, evidence, and confirmed closure."
  methodology: "Responders work from a trusted device, prioritize the recovery root, change each independently affected service, and distinguish requested actions from confirmed results."
  asset_urls: []
---

# Create a Response Plan for Exposed Account Credentials

> **In short:** Move to a trusted device and connection, stop using the suspected page or browser, and identify exactly which secret was exposed. Secure the recovery email first when it is affected, then change the exposed Norva or authorized-source password through its official destination to a new unique value. Review devices, sessions, recovery methods, and account changes, report the event, and track every action until confirmed.

Exposure can mean a password was entered on a fake page, shown in a screenshot, saved on a shared browser, sent in chat, reused on a breached service, or observed by another person. The response must fit the actual boundary instead of resetting everything blindly.

## Contain the immediate interaction

Stop entering information. Close the suspicious page, disconnect a potentially compromised shared device from further account work, and preserve the original message, page address, time, and non-sensitive circumstances.

Use a known clean, updated device and trusted connection for recovery. If malicious software may be involved, follow the device maker or organization's security process before trusting that device again.

## Identify the exposed boundary

List whether the event involved:

- Norva account password;
- recovery email password or code;
- device-platform credential;
- compatible authorized-source credential;
- password-manager master credential;
- one-time or recovery code;
- session token or live reset link.

Do not copy the secret into the incident log. Mark **possible** or **confirmed** and record how the conclusion was reached.

## Protect the recovery root

If the recovery email or password manager is affected, secure it first or in a coordinated sequence. Review recovery methods, devices, sessions, forwarding, filters, and delegated access using current official provider guidance.

The [recovery-email security guide](/blog/secure-recovery-email-media-account/) prevents an attacker from resetting the newly changed media password.

## Change affected credentials independently

Open each service's known official destination directly. Generate a new unique password in the trusted manager. Change only the accounts that are exposed or reused, but cover every service that shared the same old value.

Use the [credential separation guide](/blog/separate-account-and-source-credentials/) to keep Norva and authorized sources independent. A Norva password change does not change source credentials, and source exposure does not authorize entering that secret into Norva support.

## Review devices, sessions, and changes

Inspect current official controls for devices, sessions, recovery information, account email, profile changes, and other settings. Remove access that is unknown, lost, temporary, or no longer needed.

Do not assume a password change ends every session unless current service documentation confirms it. Record actions as **requested**, **pending**, or **confirmed**.

## Investigate the phishing or support path

If the exposure began on a fake page, follow the [phishing-page response](/blog/recognize-media-account-phishing-page/), report the message through the email provider, and contact Norva using the known support address. If a fake support agent requested the secret, preserve the channel and report the impersonation.

Share only redacted evidence. Never send a replacement password, one-time code, recovery code, or source credential to support.

## Restore household access carefully

Tell authorized household users which sessions were closed and when a new password-manager share is available. Do not send the new password through the same exposed channel. Revoke former access and update responsibility records.

Monitor official alerts and account state after the change. Use service-specific guidance rather than a universal incident-monitoring period.

## Original evidence: credential exposure incident ledger

| Time | Boundary | Evidence | Action | Status | Owner | Next check |
| --- | --- | --- | --- | --- | --- | --- |
|  | Recovery email | Possible / Confirmed | Secure and review | Requested / Confirmed |  |  |
|  | Norva account | Possible / Confirmed | Change and review sessions | Requested / Confirmed |  |  |
|  | Authorized source | Possible / Confirmed | Change independently | Requested / Confirmed |  |  |
|  | Device/browser | Possible / Confirmed | Isolate and inspect | Requested / Confirmed |  |  |

Keep secrets, live tokens, recovery codes, and unredacted screenshots out of the ledger.

## Common mistakes and limitations

- Changing passwords on the suspected device.
- Securing Norva while email remains compromised.
- Forgetting every service that reused the old value.
- Assuming one password change closes all sessions.
- Pasting source credentials into a support ticket.
- Marking remote actions complete before confirmation.
- Sending the replacement password through the exposed channel.

## Frequently asked questions

### Which password should I change first?

Protect the recovery root first when it is compromised, then each exposed or reused service through its official destination. The order depends on the actual incident.

### Should I delete the account?

Not automatically. Contain access, secure recovery, change credentials, review sessions, and contact official support before considering a separate account-deletion decision.

### How do I know the incident is closed?

Every affected boundary has a unique replacement credential, recovery is secure, unknown sessions are addressed, evidence is preserved, and official account checks show the intended state.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
- [Google Account Help: Secure a compromised account](https://support.google.com/accounts/answer/6294825)
