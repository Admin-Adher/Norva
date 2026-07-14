---
content_id: "NVB-803"
title: "Data Controller vs. Processor: A Plain-English Explanation"
seo_title: "Data Controller vs. Processor in Plain English"
meta_description: "Learn how data controllers and processors differ, why one organization can hold different roles, and how to review each media-app data flow carefully."
slug: "data-controller-vs-processor-explained"
canonical_url: "https://norva.tv/blog/data-controller-vs-processor-explained/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "privacy-role-explainer"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between a data controller and a processor?"
supporting_questions:
  - "How can purpose, means, instructions, and service context reveal a role?"
  - "Why can one organization hold different roles for different processing?"
audience:
  - "Norva users reading privacy roles"
  - "People seeking a non-legal plain-English data-flow explanation"
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
excerpt: "Controller and processor are processing-specific roles: one decides purposes and essential means, while the other generally handles data on documented instructions for that activity."
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
  - "/blog/read-privacy-policy-ten-questions/"
  - "/blog/review-third-party-processors/"
  - "/blog/connected-source-data-flow-map/"
cta:
  label: "See How Norva Describes Its Privacy Roles"
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
  type: "processing-role decision worksheet"
  summary: "A worksheet describes one processing activity, purpose decision, essential-means decision, instruction source, operational actor, independent use, named contract role, evidence, and unresolved classification."
  methodology: "The reader analyzes one activity at a time using current first-party disclosures, separates business labels from functional evidence, and reserves legal conclusions for qualified jurisdiction-specific review."
  asset_urls: []
---

# Data Controller vs. Processor: A Plain-English Explanation

> **In short:** A controller decides why personal data is processed and the essential way that processing occurs. A processor handles personal data for a controller under documented instructions. The label applies to a specific activity, not permanently to an entire company: one organization can hold different roles in different contexts, and independent purposes may change the analysis. Read the policy and data flow together; legal classification depends on facts and applicable law.

This explanation supports policy literacy, not legal advice. “Controller,” “processor,” “service provider,” “partner,” and “vendor” may overlap in ordinary language but are not interchangeable without examining the actual processing.

## Start with one activity

Do not ask, “Is Company A a processor?” in the abstract. Ask, “For account authentication,” “for subscription verification,” or “for a user-requested source connection, who decides the purpose and essential means?”

Breaking the system into activities avoids assigning one role to every data flow. The [connected-source map](/blog/connected-source-data-flow-map/) provides a request-by-request canvas.

## Understand the controller question

The European Commission summarizes a controller as the organization deciding why and how personal data is processed. In a practical reading worksheet, look for who defines the service purpose, required category, main recipients, retention criteria, and user-facing policy.

A controller can use outside infrastructure without giving up every decision. It also has responsibilities that cannot be understood from a single vendor list.

## Understand the processor question

A processor generally processes personal data on behalf of a controller. Look for instruction language, contracted function, confidentiality, security obligations, assistance, deletion or return terms, and rules about additional processors.

Providing software or hosting does not automatically prove processor status for every activity. If a provider decides an independent purpose for some data, that part requires separate analysis.

## Recognize mixed and changing roles

One organization may process account information under one role and separately determine purposes for its own billing, security, or legal records. Two entities may also jointly determine parts of a processing activity.

The correct lesson for a reader is not to memorize brand labels. Document the activity, decisions, instruction path, and independent use, then treat unclear classification as a question.

## Apply the framework to a media service

Norva's privacy notice identifies the operator as data controller and lists service providers that process data on its behalf for authentication, hosting, delivery, and entitlement verification. It separately describes requests to a compatible source configured by the user.

Record those statements exactly and check their date. Do not conclude that Norva controls the source's independent practices or that a payment provider is a processor for every purpose it performs.

Use the [ten-question policy guide](/blog/read-privacy-policy-ten-questions/) to connect role wording with categories, purposes, destinations, retention, and controls.

## Read processor lists critically

For each named provider, ask which function it supplies, which category it may receive, whether a linked notice or list exists, how changes are communicated, and whether international processing is mentioned.

The [processor-review guide](/blog/review-third-party-processors/) turns a list into an evidence table without claiming access beyond what the policy states.

## Avoid role shortcuts

“Cloud host” describes a service function, not the complete legal analysis. “Third party” does not mean controller. “Partner” does not mean processor. “We share only with processors” is a claim to compare with the detailed list and each activity.

Similarly, an entity may be named in a privacy policy because it has its own direct relationship with the user. That possibility requires reading its official terms rather than guessing.

## Ask useful factual questions

If a role is unclear, ask official support which service function the organization provides, what category is involved, whether it acts on Norva's instructions for that activity, and where the current processor list or notice can be found.

Do not send personal data or credentials to make the question concrete. A hypothetical category is usually sufficient.

## Original evidence: processing-role decision worksheet

| Processing activity | Purpose decision | Essential-means decision | Operational actor | Instruction evidence | Independent use | Stated role | Open question |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Account authentication |  |  |  |  |  |  |  |
| Cloud database hosting |  |  |  |  |  |  |  |
| Subscription verification |  |  |  |  |  |  |  |
| User-selected source request |  |  |  |  |  |  |  |

## Common mistakes and limitations

- Assigning a role to a whole company forever.
- Treating “vendor” as a legal classification.
- Ignoring independent purposes within one relationship.
- Assuming every named recipient sees every data category.
- Equating technical access with decision-making.
- Using a policy summary without its date.
- Presenting a worksheet result as legal advice.

## Frequently asked questions

### Can one company be both controller and processor?

Yes, for different processing activities or relationships. Analyze each purpose, means, and instruction path separately.

### Is every cloud provider a processor?

Not automatically for every activity. Examine the contracted service, instructions, independent purposes, and applicable legal framework.

### Does a processor have no responsibilities?

No. Applicable rules and contracts can impose processor duties; the official sources and actual relationship determine them.

## Your next step

[See How Norva Describes Its Privacy Roles](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [European Commission: Controller and processor](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/what-data-controller-or-data-processor_en)
- [European Commission: Processing on behalf of an organization](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/can-someone-else-process-data-my-organisations-behalf_en)
