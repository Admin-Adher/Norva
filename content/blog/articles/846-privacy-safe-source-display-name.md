---
content_id: "NVB-846"
title: "Choose a Privacy-Safe Display Name for a Source"
seo_title: "Choose a Privacy-Safe Source Display Name"
meta_description: "Choose a source label without exposing a hostname, address, username, owner, location, provider account, subscription detail, credential, or security role."
slug: "privacy-safe-source-display-name"
canonical_url: "https://norva.tv/blog/privacy-safe-source-display-name/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "privacy-naming-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can I choose a privacy-safe display name for a connected source?"
supporting_questions:
  - "Which endpoint, identity, location, and security details should be excluded?"
  - "How can several sources remain distinguishable on shared screens?"
audience:
  - "Norva users naming a compatible source"
  - "Households managing more than one authorized source"
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
  source_of_truth: "https://norva.tv/privacy"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A safe source label distinguishes authorized connections for household users while revealing no endpoint, credential, account owner, location, or security information on shared screens."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/choose-privacy-safe-display-name/"
  - "/blog/collect-source-details-securely/"
  - "/blog/baseline-before-second-source/"
cta:
  label: "Review Norva's Source Data Notice"
  href: "https://norva.tv/privacy"
  intent: "trust"
sources:
  - "https://norva.tv/privacy"
  - "https://csrc.nist.gov/pubs/sp/800/122/final"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source-label exposure and collision test"
  summary: "A test scores household recognition, uniqueness, endpoint disclosure, owner identity, location, provider detail, account status, security role, shared-screen exposure, screenshot risk, and rename cost."
  methodology: "Candidates are fictional and tested from a guest's perspective, current character limits are verified, secrets and sensitive attributes are excluded, and labels are compared for collision before saving."
  asset_urls: []
---

# Choose a Privacy-Safe Display Name for a Source

> **In short:** Use a short neutral label that authorized household users can distinguish without revealing the source hostname, address, port, path, username, account owner, email, location, provider account, plan, expiry, security role, password hint, or token fragment. Assume the label may appear on a shared television, screenshot, notification, catalog filter, log, or support image. Test both privacy and collision risk, follow current character rules, and store technical details separately in protected records.

A source label is a convenience field, not a credential or proof of ownership. It may still become personal data when linked to an account or household.

## Map every visible surface

Check source selectors, catalog filters, settings, search results, profile screens, shared televisions, screenshots, notifications, exported settings, and support attachments. Do not assume the label remains inside an administrator-only menu.

The [account display-name guide](/blog/choose-privacy-safe-display-name/) uses the same exposure test for account labels.

## Exclude endpoint structure

Do not paste a hostname, numeric network address, port, path, query, or server identifier into the label. Those details can expose private infrastructure and make a screenshot more useful to an attacker.

Keep address structure with the protected source record described in the [secure details guide](/blog/collect-source-details-securely/).

## Exclude identity and location

Avoid full names, email addresses, phone numbers, street names, workplaces, schools, exact rooms, and travel locations. A label such as "Bedroom Source" can reveal household layout on a shared or photographed screen.

Use neutral categories, colors, or agreed fictional names instead.

## Exclude security and billing clues

Never include password hints, token suffixes, recovery words, account roles, renewal dates, plan status, payment provider, or subscription reference. A label is often copied into logs or screenshots where those clues do not belong.

Do not mark a source "Admin" or "Owner" unless the role is genuinely needed and the exposure accepted.

## Maintain useful distinctions

Privacy-safe does not mean identical. If two authorized sources use the same label, household users may browse, remove, or troubleshoot the wrong one. Choose names that distinguish purpose without exposing underlying infrastructure.

Before adding a second source, the [catalog-baseline guide](/blog/baseline-before-second-source/) records which label and catalog state belong to the first.

## Test from a guest's perspective

Imagine a visitor, repair technician, hotel guest, screenshot recipient, or support agent seeing the label. Could they infer the owner's identity, home layout, provider, endpoint, billing state, or security importance? Simplify if the answer is yes.

Also test how the label looks when truncated on a television. Ask another authorized household user to identify it without hints.

## Verify product constraints

Check the current Norva field length, allowed characters, duplicate-label behavior, and rename control. Do not claim that a rename propagates to every supported device unless current documentation or testing confirms it.

Record the old and new labels during a controlled change without including source secrets.

## Use a label that survives routine change

Avoid dates, temporary plan states, device names, or administrators likely to change. A stable neutral label reduces unnecessary renaming and makes before-and-after catalog evidence easier to compare. If the source's purpose changes materially, reassess the label rather than preserving a misleading name. Document only the visible old and new labels, not the endpoint behind them.

## Original evidence: source-label exposure and collision test

| Candidate | Recognizable | Endpoint detail | Identity or location | Security clue | Collision | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Blue Library | Household-specific | None | None | None | Check |  |
| Host and port | High | High | Possible | High | Low | Reject |
| Owner email | High | Possible | High | Medium | Low | Reject |
| Source A | Medium | None | None | None | Medium |  |

## Common mistakes and limitations

- Using the source URL as its label.
- Adding a username or owner email.
- Revealing a room, address, or workplace.
- Including plan expiry or provider details.
- Using a password or token hint.
- Choosing identical labels for different sources.
- Assuming rename behavior across devices.

## Frequently asked questions

### Can I use the provider name?

Possibly, but consider whether it exposes household subscriptions and whether a neutral label provides enough recognition with less disclosure.

### Is a source label secret?

Usually it is user-facing rather than an authentication secret, but it can still reveal personal, endpoint, or account context.

### Does renaming change the source address?

Do not assume so. A display label and connection address are separate fields unless current product guidance says otherwise.

## Your next step

[Review Norva's Source Data Notice](https://norva.tv/privacy)

## Sources

- [Norva privacy policy](https://norva.tv/privacy)
- [NIST: Guide to Protecting Personally Identifiable Information](https://csrc.nist.gov/pubs/sp/800/122/final)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
