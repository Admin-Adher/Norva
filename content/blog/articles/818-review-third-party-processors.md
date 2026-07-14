---
content_id: "NVB-818"
title: "How to Review Third-Party Processors in a Privacy Policy"
seo_title: "How to Review Privacy Policy Processors"
meta_description: "Learn to review processor identity, function, data categories, instructions, location, subprocessors, safeguards, retention, changes, and exit handling."
slug: "review-third-party-processors"
canonical_url: "https://norva.tv/blog/review-third-party-processors/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "privacy-review-guide"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should I review third-party processors listed in a privacy policy?"
supporting_questions:
  - "Which facts explain a processor's role and data access?"
  - "How should subprocessors, locations, changes, and deletion be reviewed?"
audience:
  - "People evaluating service-provider disclosures"
  - "Norva users reviewing the privacy policy"
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
excerpt: "A processor review connects each provider to a service function, data category, instruction, location, subprocessor chain, safeguard, retention rule, and exit event."
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
  - "/blog/data-controller-vs-processor-explained/"
  - "/blog/international-data-transfer-questions/"
  - "/blog/audit-privacy-policy-changes/"
cta:
  label: "Review Norva's Current Provider List"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/what-data-controller-or-data-processor_en"
  - "https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/can-someone-else-process-data-my-organisations-behalf_en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "processor evidence register"
  summary: "A register maps provider, named role, service function, instructions, categories, people, systems, locations, subprocessors, safeguards, retention, exit process, and change date."
  methodology: "The reviewer uses current operator and provider documents, assigns roles per activity rather than company, records unresolved contractual facts, and avoids inferring data access from branding alone."
  asset_urls: []
---

# How to Review Third-Party Processors in a Privacy Policy

> **In short:** For each listed provider, record its legal name, service function, processing activity, data categories, affected people, documented instructions, systems, locations, subprocessors, security measures, retention or deletion path, and change date. Assign controller or processor roles per activity, not permanently to a brand. A connected source, store, or payment provider may have independent purposes, so do not call every external recipient a processor without current factual and contractual evidence.

A processor generally handles personal data on behalf of a controller and under documented instructions. The exact role depends on the processing activity and applicable law. This guide supports evidence gathering, not a legal determination.

## Begin with the service function

Provider names are less informative than functions. Authentication and database, hosting and delivery, customer support, diagnostics, application-store billing, and a user-selected source involve different data and decisions.

The [controller-versus-processor explainer](/blog/data-controller-vs-processor-explained/) shows why one organization can be a processor for one activity and a controller for another.

## Map categories and people

Record whether the provider handles account identifiers, profiles, usage state, device records, source settings, technical logs, entitlement status, or support correspondence. Then identify which account owners, profile users, trial users, or support contacts are affected.

Avoid phrases such as "all user data" unless the policy or contract actually supports that scope.

## Look for documented instructions

European Commission guidance describes a processor as acting under the controller's instructions, with a contract or legal act covering required topics. A public privacy notice may summarize this relationship without publishing the agreement.

Write "contract not public" when that is the evidence. Do not assume there is no contract, and do not invent its terms.

## Review subprocessors and locations

A processor may use another provider. Look for a current subprocessor list, locations, service descriptions, notification method, effective dates, and objection or termination process where applicable.

Use the [international-transfer question set](/blog/international-data-transfer-questions/) when data is stored, processed, or remotely accessed across borders. Location and transfer mechanism require separate rows.

## Check retention and exit handling

Ask what happens when the operator changes provider, the service contract ends, an account closes, or a user exercises a valid request. Deletion, return, archive, backup expiry, and legally required records should not be collapsed into one outcome.

Provider exit is also a continuity risk. A responsible review considers data export, migration, key ownership, revocation, and evidence of completion without asking for sensitive operational details publicly.

## Norva's current provider categories

Norva's current notice names Supabase for authentication and database services, Cloudflare for hosting and delivery, stores or payment providers for entitlement, and the source host configured by the user for source requests. These relationships should be verified against the live notice and each provider's current documentation.

Do not assume the configured source is Norva's processor. Its role depends on the user's relationship, source terms, and actual processing purposes.

## Watch for change signals

A new provider, renamed company, changed function, new region, expanded category, or revised deletion path can be material. The [privacy-policy change audit](/blog/audit-privacy-policy-changes/) provides a dated comparison method.

Never rely solely on an old screenshot or cached provider list.

## Original evidence: processor evidence register

| Provider | Function | Role stated | Categories | Instructions evidence | Location | Subprocessors | Exit handling | Checked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Authentication provider | Account access | Verify notice | Account identifiers | Public summary or contract | Verify | Verify list | Delete or return terms |  |
| Hosting provider | Delivery | Verify notice | Request and service data | Public summary or contract | Verify | Verify list | Migration and deletion |  |
| Store or payment provider | Billing and entitlement | May be independent | Subscription data | Provider terms | Verify | Provider-defined | Original-provider controls |  |
| Connected source | User-selected content source | Do not infer | Source-defined | Source terms | Source-defined | Source-defined | Source control |  |

## Common mistakes and limitations

- Calling every external company a processor.
- Assigning one role to a company for all activities.
- Inferring access to all data from infrastructure branding.
- Treating a missing public contract as proof no contract exists.
- Ignoring subprocessors, regions, and remote access.
- Combining operator account closure with provider retention.
- Using an outdated provider list.

## Frequently asked questions

### Is an application store always a processor?

No. A store may determine independent billing or account purposes; role analysis depends on the specific activity and facts.

### Does a hosting provider read every record?

Do not infer human access from hosting alone. Review technical access, encryption, roles, controls, and published documentation.

### Where can I find subprocessor changes?

Check the operator's current notice, provider list, contractual portal, change notices, and official support channel.

## Your next step

[Review Norva's Current Provider List](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: Controller or processor](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/what-data-controller-or-data-processor_en)
- [European Commission: Processing on an organization's behalf](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/can-someone-else-process-data-my-organisations-behalf_en)

