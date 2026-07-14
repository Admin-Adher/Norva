---
content_id: "NVB-878"
title: "Import Works on One Network but Not Another: Isolate the Path"
seo_title: "Import Works on One Network but Not Another"
meta_description: "Troubleshoot network-dependent imports by comparing the same device, account, source, request, security context, messages, timing, and source reachability."
slug: "import-works-on-one-network-only"
canonical_url: "https://norva.tv/blog/import-works-on-one-network-only/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "network-path-import-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot network-dependent catalog import?"
supporting_questions:
  - "Which device, account, source, request, DNS, security, response, and timing facts should match?"
  - "How can networks be compared without weakening protections?"
audience:
  - "Norva users seeing import work on one network only"
  - "Household network administrators"
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
excerpt: "A network-path comparison holds the device, account, profile, source, application version, and request stable while recording reachability, security, DNS, messages, and timing."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/source-connection-timeout-triage/"
  - "/blog/source-certificate-warning-response/"
  - "/blog/import-sync-support-packet/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://www.rfc-editor.org/rfc/rfc9110"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "two-network import path comparison"
  summary: "A comparison holds device, application version, account, profile, source, and request stable while recording network type, gateway or policy owner, DNS and filtering context, source reachability, certificate state, exact messages, and timestamps."
  methodology: "The user captures one baseline per trusted network, changes only the network, avoids disabling protections, records ordinary reachability and response evidence, and escalates the paired result to the appropriate support owner."
  asset_urls: []
---

# Import Works on One Network but Not Another: Isolate the Path

> **In short:** Use the same trusted device, Norva account, profile, application version, authorized source, and import step on both networks. Record network type, time, source and Norva reachability, exact messages, certificate state, DNS or filtering controls you legitimately manage, and whether ordinary pages load. Change only the network, never disable security or install unknown profiles, and treat the result as path evidence rather than proof of a specific cause.

A one-network difference narrows the context, but many variables can travel with a network: addressing, DNS resolution, filtering, captive portals, certificate interception, router state, or source restrictions. The comparison should isolate, not speculate.

## Preserve both baseline attempts

Record the successful and unsuccessful request times, exact visible stage or message, device, operating system, Norva version, account, profile, masked source label, and actions taken. Do not repeat requests until the two baselines are documented.

The [import and sync handbook](/blog/catalog-import-sync-troubleshooting-handbook/) provides the wider evidence-layer model.

## Hold the device and request stable

Use the same device and application state where practical. Confirm source selection, filters, grouping, and account context did not change. If a different device must be used, label the test as a multi-variable comparison and avoid strong conclusions.

## Identify each network safely

Record a privacy-safe label such as home wired, home wireless, trusted mobile connection, or managed workplace network. Note who controls it and whether a captive portal, content filter, VPN, proxy, custom DNS, parental control, or enterprise policy is knowingly active. Do not publish public addresses or sensitive configuration.

## Compare ordinary reachability

On each network, record whether official Norva support and the authorized source route load normally. Note redirects, timeouts, access messages, or maintenance pages. The [source-timeout triage](/blog/source-connection-timeout-triage/) helps when the endpoint does not respond.

HTTP status semantics can describe a response but cannot identify Norva's internal cause.

## Record certificate state

If a certificate or secure-connection warning appears on only one network, stop entering credentials. Do not bypass it. Record hostname in masked form, time, device, network, and exact warning, then follow the [certificate-warning response](/blog/source-certificate-warning-response/).

## Compare managed controls

Review only settings you are authorized to manage: router date and time, DNS provider, filtering rules, parental controls, device isolation, firewall policy, VPN, or proxy. Record state; do not turn off broad protection to see whether the import works. On a workplace, school, hotel, or other managed network, contact its administrator.

## Check captive and sign-in state

Confirm the device completed any legitimate network sign-in and can load ordinary secure pages. Avoid entering source or Norva credentials into a captive-portal page. A portal or redirect is a network observation, not an application credential prompt.

## Run one controlled comparison

After recording both baselines, switch only between two trusted networks and repeat the same supported request once if current Norva guidance permits. Reset no sources, credentials, application data, or device settings. Record success, failure, message, and elapsed observation.

## Route the evidence correctly

If only one managed network fails and its administrator confirms a policy or path issue, work with that owner. If source reachability differs, include source-provider evidence. If Norva behavior differs while ordinary source access remains the same, send the paired packet to Norva support using the [support-packet guide](/blog/import-sync-support-packet/).

## Original evidence: two-network import path comparison

| Context | Network A | Network B |
| --- | --- | --- |
| Device, OS, app version |  |  |
| Account, profile, source |  |  |
| Network type and owner |  |  |
| DNS, VPN, proxy, filtering |  |  |
| Norva and source reachability |  |  |
| Certificate state |  |  |
| Import message and result |  |  |
| Timestamp |  |  |

## Common mistakes and limitations

- Comparing different devices, accounts, or source settings.
- Disabling firewalls, certificate validation, or parental controls broadly.
- Installing unknown profiles or certificates.
- Treating a network correlation as a proven root cause.
- Repeating imports and credentials changes between tests.
- Sharing public addresses or private network configuration.

## Frequently asked questions

### Should I disable the firewall to test?

No broad disablement is appropriate. Record authorized settings and work with the network owner or current official support guidance.

### Does success on mobile data prove my router is broken?

No. It shows a network-context difference. DNS, filtering, routing, source policy, and other path factors still require evidence.

### What if a certificate warning appears on one network?

Stop entering credentials, preserve the exact warning, and follow the certificate-response path without bypassing validation.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
