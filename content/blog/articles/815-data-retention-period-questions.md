---
content_id: "NVB-815"
title: "How to Read Data Retention Language Critically"
seo_title: "How to Review Data Retention Language"
meta_description: "Learn to evaluate retention clauses by category, purpose, trigger, duration, deletion outcome, backups, exceptions, recipients, controls, and evidence date."
slug: "data-retention-period-questions"
canonical_url: "https://norva.tv/blog/data-retention-period-questions/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "privacy-review-guide"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should I read data retention language in a media service privacy policy?"
supporting_questions:
  - "What is the difference between a fixed period and an event-based criterion?"
  - "How should deletion, anonymisation, backups, and exceptions be recorded?"
audience:
  - "People evaluating privacy-policy retention statements"
  - "Norva users planning account or profile changes"
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
excerpt: "Retention language becomes testable when each category has a purpose, start event, end event or duration, outcome, exception, recipient, and dated source."
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
  - "/blog/anonymisation-vs-deletion/"
  - "/blog/audit-privacy-policy-changes/"
  - "/blog/read-privacy-policy-ten-questions/"
cta:
  label: "Read Norva's Current Retention Statement"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en"
  - "https://cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "retention clause parsing register"
  summary: "A register extracts category, purpose, collection event, active-use period, archive or backup state, end trigger, outcome, exception, external recipient, control, and policy date."
  methodology: "The reviewer quotes no more than necessary, paraphrases current first-party clauses, distinguishes stated periods from assumptions, and routes jurisdiction-specific conclusions to qualified reviewers."
  asset_urls: []
---

# How to Read Data Retention Language Critically

> **In short:** Read retention one data category at a time. Record when collection starts, the purpose, whether the policy gives a fixed period or an event-based criterion, what action starts deletion, whether the outcome is deletion or anonymisation, which backups or legal records may remain, and which parties follow separate rules. A vague phrase is a question to clarify, not permission to invent a deadline or accuse the provider of indefinite storage.

Retention means more than a number of days. A useful policy can use a fixed duration, an account-lifecycle event, a purpose-based criterion, or a legally required period. This article teaches critical reading and does not determine compliance.

## Separate categories before looking for dates

Account identifiers, usage state, device records, entitlement status, technical logs, support messages, source settings, and local downloads can have different useful lives. One general sentence should not automatically be applied to every category.

The [ten-question privacy-policy guide](/blog/read-privacy-policy-ten-questions/) provides the broader context; this article expands its retention question.

## Identify the start and end triggers

A fixed period needs a starting event: collection, last use, account closure, support resolution, or security event. An event-based statement needs a defined end: while the account is active, until a feature is disabled, while required for the service, or until a legal obligation ends.

If the trigger is absent, write "start event not stated" rather than choosing one.

## Distinguish active data, archives, and backups

Information can move from an active database into restricted archives or backups before final expiry. Ask whether backup deletion follows a cycle, whether restored backups reapply deletion records, and who can access archived material.

Do not assume a backup is instantly searchable by normal product staff, but do not assume it contains no retained record either. Evidence should describe the actual safeguards.

## Deletion and anonymisation are different outcomes

Deletion removes data from a system or makes it no longer available there. Anonymisation aims to prevent identification irreversibly under the relevant standard. Pseudonymisation leaves a possible linkage and is not the same outcome.

Use the [anonymisation versus deletion guide](/blog/anonymisation-vs-deletion/) before treating these words as synonyms.

## Record exceptions precisely

A policy may preserve limited billing, fraud, security, dispute, or legal records. Ask which categories, purposes, access restrictions, and periods apply. A narrowly stated exception should not be expanded into a claim that every account record remains.

Entitlement records held by a store or payment provider may follow that provider's policy even when the media account closes.

## Local and external records need their own rows

Deleting an eligible offline item on one device is not the same as deleting synchronized progress. Uninstalling may remove local application data but does not prove account closure. Removing a source from an app does not delete records held by that source.

The [connected-source data-flow map](/blog/connected-source-data-flow-map/) identifies which actor controls each row.

## Norva's current wording

Norva's current privacy notice says data is kept while an account remains active and that account deletion leads to deletion or anonymisation, except for limited records required for stated legal purposes. It also says local downloads are removed when deleted or when the application is uninstalled.

These sentences need live verification and should not be converted into an exact number of hours or days. The [privacy-policy change audit](/blog/audit-privacy-policy-changes/) explains how to compare later revisions.

## Original evidence: retention clause parsing register

| Category | Start event | Purpose | Active period | End trigger | Outcome | Exception | External actor | Evidence date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Account | Account creation | Account service | While active, if stated | Closure request | Delete or anonymise, as stated | Limited records | Auth provider |  |
| Usage state | Playback or choice | Continuity | Policy criterion | Profile or account event | Verify wording | Verify wording | Service |  |
| Diagnostic log | Error or request | Security or debugging | Stated log period | Expiry criterion | Delete or aggregate | Security need | Named processor |  |
| Local download | User download | Offline use | Device lifecycle | Delete or uninstall | Local removal | Device backups? | Device platform |  |

## Common mistakes and limitations

- Looking for one universal duration for every category.
- Ignoring the event that starts a stated period.
- Treating deletion, anonymisation, and pseudonymisation alike.
- Assuming uninstall closes the account or cancels billing.
- Extending a limited legal-record exception to all data.
- Forgetting external sources, stores, and device backups.
- Promising an exact deadline absent current official wording.

## Frequently asked questions

### Must every policy give a number of days?

Not always. A clear event-based or purpose-based criterion can explain retention, subject to applicable rules and the specific context.

### Does account deletion remove store billing records?

Not necessarily. Stores and payment providers maintain separate records and controls under their own terms and obligations.

### Is anonymised data still account data?

Proper anonymisation should prevent identification under the applicable standard; pseudonymous or merely de-linked data may still be linkable.

## Your next step

[Read Norva's Current Retention Statement](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: Data-processing principles](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/principles-gdpr/overview-principles/what-data-can-we-process-and-under-which-conditions_en)
- [CNIL: Data retention periods](https://cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees)
