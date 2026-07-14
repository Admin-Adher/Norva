---
content_id: "NVB-854"
title: "Source Outage or Account Problem? Separate the Signals"
seo_title: "Source Outage vs. Account Problem Signals"
meta_description: "Separate source outage from account trouble by comparing provider status, reachability, authentication responses, devices, networks, users, and timestamps."
slug: "source-outage-vs-account-problem"
canonical_url: "https://norva.tv/blog/source-outage-vs-account-problem/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "fault-isolation-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I distinguish a source outage from an account problem?"
supporting_questions:
  - "Which provider, network, endpoint, authentication, and user signals matter?"
  - "How can comparisons remain controlled and privacy-safe?"
audience:
  - "Norva users diagnosing source access"
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
excerpt: "Outage and account diagnosis becomes reliable when endpoint, network, provider, authentication, user, device, and time signals are compared one variable at a time."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/source-connection-timeout-triage/"
  - "/blog/credential-entry-error-without-exposure/"
  - "/blog/source-connection-maintenance-audit/"
cta:
  label: "Use Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://norva.tv/support"
  - "https://www.rfc-editor.org/rfc/rfc9110"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "outage versus account signal matrix"
  summary: "A matrix records official status, name resolution, connection, certificate, response class, account portal status, authentication message, authorized comparison account, device, network, timestamps, scope, and next owner."
  methodology: "The administrator starts with public provider evidence, tests only authorized accounts and endpoints, changes one variable, avoids credential sharing or repeated attempts, and classifies conclusions as likely rather than certain until confirmed."
  asset_urls: []
---

# Source Outage or Account Problem? Separate the Signals

> **In short:** Check the provider's status and endpoint address, reachability, and certificate before changing credentials. An outage is more likely when users, devices, or networks fail during a period and the provider confirms disruption. An account problem is more likely when the endpoint responds but an account is rejected, expired, locked, or changed. Use one-variable comparisons, timestamps, and provider evidence; never share credentials or label a cause as proven from one error.

Fault isolation ranks evidence. It does not turn a few household tests into proof about an entire provider.

## Start with official status

Check a trusted provider status page or support channel for maintenance, outage, identity change, or account-service disruption. Record notice time and affected component.

No public notice does not prove there is no outage; it simply removes one supporting signal.

## Validate the endpoint path

Confirm address, automatic clock, name resolution, connection, and certificate identity. The [timeout triage](/blog/source-connection-timeout-triage/) separates each stage.

If no response reaches authentication, do not begin with a password reset.

## Interpret responses by layer

A reachable endpoint can return a redirect, authentication challenge, client error, server error, or provider-defined message. RFC 9110 gives general HTTP semantics, while the source provider defines its endpoint behavior.

Record the class and exact message without copying response bodies containing personal data.

## Check source account status

Open the official source account portal directly. Verify subscription or access status, recovery notices, recent password changes, lockout, stronger-authentication requests, and authorized devices. Do not use a link from an untrusted error page.

The [credential-error guide](/blog/credential-entry-error-without-exposure/) handles field and secret entry safely.

## Compare scope carefully

An outage signal grows when several authorized accounts or users experience the same endpoint failure during the same period. An account signal grows when one account fails while another independently authorized account succeeds.

Never borrow credentials for comparison. Use only accounts you are authorized to administer.

## Compare one device or network

Test the same authorized account on another supported trusted device, or the same device on another authorized network, changing one variable. A device-specific failure can involve clock, application version, stored state, or local security controls.

A network-specific failure can involve routing, filtering, or DNS. Neither automatically identifies the final owner.

## Avoid disruptive experiments

Do not rotate passwords, create accounts, add sources, bypass certificates, clear all data, or reinstall before preserving evidence and isolating the layer. These actions can turn a temporary outage into a recovery problem.

Limit requests and follow provider rate guidance.

## Escalate to the right party

Send endpoint and account-portal evidence to the source provider. Send Norva-specific application behavior, versions, and redacted error context to Norva support. The [maintenance audit](/blog/source-connection-maintenance-audit/) helps prevent stale ownership or endpoint data from complicating future incidents.

Close the investigation with a confirmed scope: affected account, endpoint, region, network, device class, and time window where known. Remove speculative labels from household notes. A later provider incident report or account notice may refine the cause, so preserve a correction history instead of rewriting the original observations.

## Original evidence: outage versus account signal matrix

| Signal | Outage direction | Account direction | Observed |
| --- | --- | --- | --- |
| Official provider notice | Stronger | Neutral |  |
| Name or connection failure for many | Stronger | Weaker |  |
| Valid endpoint, one account rejected | Weaker | Stronger |  |
| Account portal shows expiry or lock | Neutral | Stronger |  |
| Same account fails on every device | Either | Either |  |
| Several authorized users fail together | Stronger | Possible shared policy |  |
| One network only fails | Network signal | Neutral |  |
| Provider confirmation | Decisive for stated scope | Decisive for stated account |  |

## Common mistakes and limitations

- Calling one timeout a provider-wide outage.
- Resetting credentials before reaching authentication.
- Borrowing another person's account.
- Treating no status notice as proof of no outage.
- Changing device, network, and address together.
- Clearing evidence before escalation.
- Sending source secrets to Norva support.

## Frequently asked questions

### Does a server error prove an outage?

It is a provider-side signal but not proof of scope or duration; compare official status, time, endpoint, and authorized users.

### Does one successful account prove mine is wrong?

It supports an account-specific direction if the endpoint and conditions are comparable, but provider policy or scope can still differ.

### Should I reset my password during an outage?

Not unless the account is independently at risk or the provider directs it; unnecessary rotation can complicate recovery.

## Your next step

[Use Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [RFC Editor: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
