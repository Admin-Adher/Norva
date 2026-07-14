---
content_id: "NVB-860"
title: "A Source-Connection Maintenance Audit"
seo_title: "Source-Connection Maintenance Audit"
meta_description: "Audit source ownership, authorization, labels, credentials, recovery, devices, categories, samples, incidents, local media, records, and removal readiness."
slug: "source-connection-maintenance-audit"
canonical_url: "https://norva.tv/blog/source-connection-maintenance-audit/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "source-maintenance-checklist"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I audit connected source settings and ownership?"
supporting_questions:
  - "Which authorization, credential, endpoint, device, catalog, and incident controls should be reviewed?"
  - "Which events should trigger an audit before the normal schedule?"
audience:
  - "Norva source administrators"
  - "Households maintaining authorized source connections"
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
estimated_reading_minutes: 8
excerpt: "A maintenance audit reconnects each source label and endpoint to its real owner, authorization, protected credential, devices, catalog behavior, incidents, and removal decision."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/rotate-source-credentials-after-exposure/"
  - "/blog/source-certificate-warning-response/"
  - "/blog/remove-obsolete-source-safely/"
  - "/blog/household-admin-source-handoff/"
cta:
  label: "Review Norva's Current Source Terms"
  href: "https://norva.tv/terms"
  intent: "retention"
sources:
  - "https://norva.tv/terms"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source connection maintenance control register"
  summary: "A register checks owner, authorization, source label, provider and terms, protected endpoint record, credential and recovery, sessions, certificate incidents, devices, local media, category and progress samples, outages, support cases, review date, and removal readiness."
  methodology: "The administrator verifies each control in its authoritative system, records status rather than secrets, retests a small sample, compares the prior audit, assigns actions, and runs event-driven reviews after ownership, exposure, endpoint, device, or policy changes."
  asset_urls: []
---

# A Source-Connection Maintenance Audit

> **In short:** On a practical schedule, verify each source's owner, authorization scope, privacy-safe label, provider terms, documented endpoint, protected credential, recovery, active sessions, supported devices, local downloads, certificate history, categories, sample playback, progress identity, outages, and support cases. Record status and dates, never secrets. Remove obsolete access, assign unresolved actions, and repeat immediately after credential exposure, owner or administrator change, endpoint migration, certificate warning, source outage, device loss, or policy change.

A source connection can keep working while ownership, recovery, devices, or documentation silently become stale. Maintenance reconnects technical success with continuing authorization.

## Verify owner and authorization

Confirm the actual source owner, administrator, authorized household profiles, purpose, provider terms date, and next review or expiry. A credential that still works is not proof of continuing permission.

Use the source authorization evidence card from the planning guide.

## Review labels and documentation

Confirm the visible label remains privacy-safe and uniquely identifies the intended source. Check that protected records point to current official provider documentation and the expected endpoint structure.

Do not copy the full private address into the audit.

## Review credentials and recovery

Confirm the Norva and source passwords remain separate, protected storage access is current, former administrators are removed, recovery channels belong to authorized owners, and stronger authentication is enabled where supported.

If exposure is suspected, use the [credential-rotation response](/blog/rotate-source-credentials-after-exposure/) rather than merely marking the audit complete.

## Review endpoint identity

Check documented hostname changes, provider maintenance, and prior certificate warnings. Do not proactively bypass or weaken validation for testing. The [certificate-warning guide](/blog/source-certificate-warning-response/) defines evidence and escalation.

Record resolved incident dates, not certificate secrets.

## Inventory devices and local media

List supported household devices using the source, obsolete or lost devices, application versions, and eligible local downloads. Remove former access and local media where authorization or household policy requires it.

Do not assume deleting one Norva configuration removes every device copy.

## Retest a small sample

Check category counts, one duplicate or version example, metadata, playback, audio, subtitles, and progress identity with a privacy-safe sample. Compare with the prior audit and explain expected source changes.

Avoid complete catalog or history exports.

## Review incidents and support

List outages, timeouts, certificate warnings, lockouts, credential changes, source migrations, and open support cases. Confirm attachments are redacted and resolved evidence no longer has broad access.

Assign one owner and due date per unresolved item.

## Remove obsolete connections

Use the [safe source-removal guide](/blog/remove-obsolete-source-safely/) when the owner, authorization, utility, or provider status no longer supports keeping a connection. Handle external billing and account closure separately.

If administration changes, use the [household source handoff](/blog/household-admin-source-handoff/).

## Compare with the prior audit

Mark new, changed, removed, unchanged, and unknown controls. Investigate an unexplained owner, label, endpoint, device, or category change. The value of maintenance lies in identifying drift, not repeating checkmarks.

End the audit with accountable actions rather than vague concerns. For each unresolved control, record a privacy-safe description, owner, priority, next review date, and official channel needed for resolution. Keep observed facts separate from suspected causes. Never store passwords, tokens, recovery codes, complete catalogs, or unnecessary household viewing data in the register. If a control belongs to an external provider, assign it to the authorized source owner and reference current official guidance. Close the action only after a new observation verifies the intended state.

## Original evidence: source connection maintenance control register

| Control | Evidence | Status | Owner | Due |
| --- | --- | --- | --- | --- |
| Owner and authorization | Current confirmation |  |  |  |
| Label and provider terms | UI and official pages |  |  |  |
| Credential and recovery | Protected systems |  |  |  |
| Endpoint and certificates | Documented host, incidents |  |  |  |
| Devices and local media | Inventory |  |  |  |
| Catalog and progress sample | Privacy-safe baseline |  |  |  |
| Incidents and support | Redacted case log |  |  |  |
| Removal readiness | Norva and provider paths |  |  |  |

## Common mistakes and limitations

- Treating technical success as continuing authorization.
- Recording passwords or endpoints in the register.
- Ignoring former administrators and recovery channels.
- Bypassing certificate validation during checks.
- Exporting full catalog and history.
- Keeping obsolete devices and downloads.
- Finding issues without assigning owners and dates.

## Frequently asked questions

### How often should I run the audit?

Choose a practical schedule and repeat relevant checks after owner, credential, endpoint, device, incident, provider, or policy changes.

### Should the audit contain source credentials?

No. Record that protected storage and access were verified, never the password, token, or recovery secret.

### Does removing a source close its external account?

No such assumption should be made. Norva configuration and source-provider account or billing are separate lifecycles.

## Your next step

[Review Norva's Current Source Terms](https://norva.tv/terms)

## Sources

- [Norva terms of service](https://norva.tv/terms)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva support](https://norva.tv/support)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
