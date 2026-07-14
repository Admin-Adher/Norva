---
content_id: "NVB-814"
title: "Questions to Ask About International Data Transfers"
seo_title: "Questions About International Data Transfers"
meta_description: "Use practical questions to review countries, recipients, safeguards, onward transfers, remote access, policy changes, and controls for international data flows."
slug: "international-data-transfer-questions"
canonical_url: "https://norva.tv/blog/international-data-transfer-questions/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "privacy-review-guide"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Which questions should I ask about international data transfers?"
supporting_questions:
  - "How can storage, processing, support access, and onward transfer differ?"
  - "Which transfer mechanisms and safeguards require current legal review?"
audience:
  - "People reading cross-border processing clauses"
  - "Norva users reviewing named service providers"
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
excerpt: "International-transfer review begins with destinations, actors, activities, categories, mechanisms, safeguards, onward access, retention, and dated evidence."
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
  - "/blog/review-third-party-processors/"
  - "/blog/read-privacy-policy-ten-questions/"
  - "/blog/data-retention-period-questions/"
cta:
  label: "Read Norva's Current Transfer Statement"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection_en"
  - "https://www.edpb.europa.eu/sme-data-protection-guide/international-data-transfers_en"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "international transfer review register"
  summary: "A register captures exporter, recipient, destination, activity, categories, people, mechanism, supplementary safeguards, onward transfer, retention, and evidence date."
  methodology: "The reviewer extracts current first-party statements, checks official regulatory explanations, records uncertainty without selecting a legal mechanism by inference, and routes legal conclusions to qualified counsel."
  asset_urls: []
---

# Questions to Ask About International Data Transfers

> **In short:** Ask which data leaves or becomes accessible from which country, who sends and receives it, which people and purposes are involved, where storage and remote support occur, which transfer mechanism is claimed, which technical and contractual safeguards apply, whether onward transfers exist, and how changes are communicated. Date every answer. Do not infer legal adequacy from a provider name or a generic promise; cross-border rules require current, fact-specific review.

International processing can involve storage in another country, a processor located abroad, remote access by support staff, or onward transfer to another provider. The legal meaning depends on applicable rules and facts. This article is an educational question set, not legal advice.

## Identify the countries and activities

"Processed internationally" is too broad for a useful map. Ask where account records are stored, where backups may be held, where support access can originate, where infrastructure providers operate, and whether the connected source has a separate location.

Use the [connected-source data-flow map](/blog/connected-source-data-flow-map/) before applying transfer questions. It prevents a source selected by the user from being silently merged with the application operator.

## Name exporters and recipients

Record the organization making data available and every known recipient. A recipient can be an affiliate, processor, subprocessor, store, payment provider, support vendor, or independent source. Different rows may require different analyses.

The [third-party processor review](/blog/review-third-party-processors/) explains how to verify service function, data category, location, contract role, and subprocessor information without guessing from a logo.

## Specify data and people

Ask whether the flow concerns account identifiers, profiles, source settings, usage state, device records, entitlement status, network data, diagnostics, or support correspondence. Also identify whether it concerns account owners, profile users, trial users, or support contacts.

Broad phrases such as "service information" should be connected to concrete examples from the current notice.

## Separate transfer mechanism from safeguard

Official European guidance describes several routes for transfers and emphasizes safeguards. A provider may refer to an adequacy decision, contractual clauses, binding rules, a derogation, or another current mechanism. Do not choose the mechanism on the provider's behalf when the notice does not say.

Encryption, access control, minimisation, and pseudonymisation can be supplementary safeguards, but a technical measure and a legal transfer mechanism are not interchangeable.

## Ask about onward transfers

A first recipient may rely on another processor or infrastructure layer. Ask how subprocessors are selected, where a current list appears, how changes are announced, whether objections are possible, and which contractual or technical protections follow the data.

Use the [ten-question privacy-policy review](/blog/read-privacy-policy-ten-questions/) to record section names and dates instead of copying undated marketing language.

## Include retention and deletion

A transfer map should say how long the recipient needs the data, what ends the relationship, how deletion is communicated downstream, and what limited records may remain. Transfer location does not replace retention analysis.

The [data-retention language guide](/blog/data-retention-period-questions/) separates numeric periods, account-lifecycle criteria, security-log windows, backups, and legal-record exceptions.

## Norva's current statement

Norva's current privacy notice states that data may be processed outside a user's country and refers to appropriate safeguards. It also names service categories such as authentication and database, hosting and delivery, store or payment providers, and the user's configured source.

Human review must verify the live wording, destinations, providers, and policy date. This draft does not declare any transfer mechanism sufficient.

## Original evidence: international transfer review register

| Exporter | Recipient | Country or region | Activity | Data category | Mechanism stated | Safeguard | Onward transfer | Evidence date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Service operator | Authentication provider | Verify current notice | Account data | Identifiers | Record exact text | Access and transport controls | Check list |  |
| Service operator | Hosting provider | Verify current notice | Service data | Request and database fields | Record exact text | Minimise and restrict | Check list |  |
| User or app | Connected source | User-selected | Source request | Source-defined | Source terms | Source-defined | Source-defined |  |

## Common mistakes and limitations

- Treating every foreign company as proof of a transfer path.
- Ignoring remote access because storage remains domestic.
- Combining mechanisms, contracts, and encryption into one term.
- Forgetting subprocessors and onward transfers.
- Assuming one policy covers a connected source.
- Using an undated processor list.
- Making a legal sufficiency conclusion without qualified review.

## Frequently asked questions

### Is foreign storage the only international transfer scenario?

No. Remote access, support, processing, and onward availability can also matter depending on the applicable rules and facts.

### Does encryption alone make every transfer lawful?

No. Encryption can be an important safeguard, but legal mechanisms and other obligations require separate analysis.

### Where should I look for destinations?

Check the current privacy notice, processor or subprocessor list, provider documentation, contractual terms, and official support clarification.

## Your next step

[Read Norva's Current Transfer Statement](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: International dimension of data protection](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection_en)
- [European Data Protection Board: International data transfers](https://www.edpb.europa.eu/sme-data-protection-guide/international-data-transfers_en)
