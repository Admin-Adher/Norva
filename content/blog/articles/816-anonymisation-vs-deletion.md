---
content_id: "NVB-816"
title: "Anonymisation vs. Deletion: Two Different Outcomes"
seo_title: "Anonymisation vs. Data Deletion Explained"
meta_description: "Learn how deletion, anonymisation, and pseudonymisation differ, what evidence supports each outcome, and which retention and account-closure questions to ask."
slug: "anonymisation-vs-deletion"
canonical_url: "https://norva.tv/blog/anonymisation-vs-deletion/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "privacy-outcome-explainer"
topic_cluster: "Privacy & Data Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "What is the difference between anonymisation and deletion?"
supporting_questions:
  - "How does pseudonymisation differ from both outcomes?"
  - "Which evidence should support an account-closure statement?"
audience:
  - "People reading account-deletion and retention clauses"
  - "Norva users preparing for account closure"
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
excerpt: "Deletion removes data from a system, while anonymisation transforms it so identification is no longer reasonably possible under the applicable standard."
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
  - "/blog/data-retention-period-questions/"
  - "/blog/audit-privacy-policy-changes/"
  - "/blog/personal-data-vs-media-data/"
cta:
  label: "Read Norva's Account Closure Statement"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://www.cnil.fr/fr/technologies/lanonymisation-de-donnees-personnelles"
  - "https://cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "data-outcome verification matrix"
  summary: "A matrix separates deletion, anonymisation, pseudonymisation, aggregation, archival restriction, and local removal by reversibility, linkage, location, purpose, and evidence."
  methodology: "The review starts from current first-party wording, maps outcomes per system, records residual linkage and backup questions, and avoids certifying anonymisation without technical and legal evidence."
  asset_urls: []
---

# Anonymisation vs. Deletion: Two Different Outcomes

> **In short:** Deletion removes a record or makes it unavailable from a defined system; anonymisation transforms information so a person can no longer be identified under the relevant standard. Pseudonymisation replaces or separates identifiers but preserves a possible linkage, so it is not anonymisation. Review each system, copy, backup, recipient, residual field, re-identification risk, and stated exception. A policy saying "delete or anonymise" describes alternative outcomes, not one identical operation.

These terms describe different lifecycle results. Their legal effect depends on jurisdiction, facts, and technical implementation, so this guide is educational rather than a certification.

## Deletion needs a defined system boundary

Ask what is deleted: an account row, profile, history item, local file, source setting, support record, token, backup copy, or store transaction. "Deleted" is incomplete without the object, system, trigger, and expected completion path.

Use the [data-retention language guide](/blog/data-retention-period-questions/) to record active storage, archives, backups, external recipients, and limited exceptions separately.

## Anonymisation changes identifiability

Anonymisation is more than removing a name or email address. Other fields, combinations, rare events, device details, or external datasets can permit singling out, linking, or inference. A robust process must consider realistic re-identification risks and the ability to reverse or reconnect data.

CNIL guidance describes anonymisation as an irreversible process and distinguishes it from pseudonymisation. A claim should be supported by method, testing, governance, and current context rather than a renamed database column.

## Pseudonymisation preserves a link

Replacing an email with an internal code can reduce direct exposure. If a separate table, key, or practical means can reconnect that code to an account, the data remains pseudonymous rather than anonymous.

Pseudonymisation can still be a valuable safeguard. The mistake is presenting it as proof that the information no longer relates to a person.

## Aggregation is not automatically anonymisation

Totals and averages can reduce identifiability, but very small groups, rare combinations, granular time windows, or repeated queries can reveal individuals. Ask about minimum group size, suppression, rounding, access, query controls, and external data.

The [personal-data versus media-data guide](/blog/personal-data-vs-media-data/) helps test whether media usage fields remain linkable in their actual context.

## One account can have several outcomes

At closure, account identifiers may be deleted, analytical records may be anonymised, limited billing records may be retained, device tokens may be revoked, and eligible local downloads may be removed through device controls. A connected source or store follows its own policy.

Norva's current privacy notice says account closure leads to deletion or anonymisation, except for limited records required for stated legal purposes. It separately describes local-download removal. Human review must verify the live notice and controls.

## Evidence should match the claim

For deletion, seek a documented trigger, scope, completion mechanism, downstream instruction, and handling of restored backups. For anonymisation, seek the transformation method, threat model, residual fields, linkage tests, access controls, and reassessment plan.

The [privacy-policy change audit](/blog/audit-privacy-policy-changes/) helps compare these statements when the notice or product workflow changes.

## Original evidence: data-outcome verification matrix

| Outcome | Identifiers removed | Link retained | Reversible | Typical evidence | Main review question |
| --- | --- | --- | --- | --- | --- |
| Deletion | Record-dependent | No record in scoped system | Backup-dependent | Deletion workflow and logs | Which systems and copies? |
| Anonymisation | Direct and indirect risks addressed | No reasonable linkage | Intended irreversible | Method and re-identification testing | Is identification still practical? |
| Pseudonymisation | Direct identifiers replaced | Yes, controlled | Usually | Key separation and access rules | Who can reconnect it? |
| Aggregation | Individual rows summarized | Context-dependent | Context-dependent | Group thresholds and query controls | Are groups too small? |
| Archive restriction | Often unchanged | Yes | Yes | Access and retention controls | Why and for how long? |

## Common mistakes and limitations

- Calling name removal anonymisation.
- Treating pseudonymisation as anonymous data.
- Assuming aggregation always prevents singling out.
- Ignoring backups, exports, logs, and downstream recipients.
- Combining local file removal with account closure.
- Promising instant deletion without official timing.
- Certifying anonymisation from policy wording alone.

## Frequently asked questions

### Is anonymised data still personal data?

Properly anonymised data should no longer identify a person under the applicable standard; the quality of the method and context are decisive.

### Does deleting my profile close my account?

Not necessarily. Profile removal and account closure are separate product events and should be verified independently.

### Can backups delay deletion?

Backup cycles can differ from active systems. Review the provider's current backup, restoration, access, and expiry explanation.

## Your next step

[Read Norva's Account Closure Statement](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [CNIL: Anonymisation of personal data](https://www.cnil.fr/fr/technologies/lanonymisation-de-donnees-personnelles)
- [CNIL: Data retention periods](https://cnil.fr/fr/passer-laction/les-durees-de-conservation-des-donnees)

