---
content_id: "NVB-845"
title: "Check Source Reachability Before Adding It to a Player"
seo_title: "Check Source Reachability Before Connecting"
meta_description: "Check source reachability from an authorized device and network by separating name resolution, connection, endpoint identity, HTTP response, and authentication."
slug: "check-source-reachability-before-adding"
canonical_url: "https://norva.tv/blog/check-source-reachability-before-adding/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "connectivity-check-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can I check whether an authorized source is reachable before adding it?"
supporting_questions:
  - "How do name resolution, timeout, refusal, certificate, response, and authentication errors differ?"
  - "Which checks can be documented without exposing the endpoint or credentials?"
audience:
  - "Norva users preparing a source connection"
  - "Support teams isolating connectivity errors"
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
excerpt: "Reachability is a layered result: a name must resolve, a connection must open, endpoint identity must be trusted, a response must arrive, and authentication must be evaluated separately."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/validate-source-address-format/"
  - "/blog/connect-one-source-at-a-time/"
  - "/blog/credential-entry-error-without-exposure/"
cta:
  label: "Open Norva's Official Support"
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
  type: "layered source reachability trace"
  summary: "A trace records authorized device and network, timestamp, masked host, name-resolution result, connection result, transport identity, HTTP status class, authentication boundary, source status, comparison device, and next owner."
  methodology: "The user tests only an authorized endpoint using provider-approved methods, records one layer at a time, never bypasses certificate warnings, masks addresses and credentials, and stops before aggressive scanning or repeated requests."
  asset_urls: []
---

# Check Source Reachability Before Adding It to a Player

> **In short:** From the intended authorized device and network, verify the source address format, automatic clock, name resolution, connection, transport certificate or endpoint identity, and response using provider-approved methods. Record the timestamp and error layer with the host masked. A timeout, refused connection, name failure, certificate warning, HTTP response, and authentication rejection mean different things. Never bypass security warnings, scan the endpoint, repeat requests aggressively, or disclose credentials while testing.

Reachability asks whether communication can reach an expected endpoint. It does not prove authorization, correct credentials, catalog compatibility, or successful playback.

## Validate the address first

Use the [source-address format guide](/blog/validate-source-address-format/) before making a request. A missing scheme, wrong port, copied whitespace, or path error can look like a network failure.

Keep the full private address out of shared notes and online checking tools.

## Use the intended environment

Test from the supported device or network that will run Norva. A work firewall, guest Wi-Fi, mobile network, home router, privacy relay, or virtual private network can change results. Record the environment without publishing network names or addresses.

Confirm automatic date and time because certificate validation can fail on a badly set clock.

## Separate name resolution

If a hostname cannot resolve, the device cannot locate an address for it. Check spelling, network connectivity, provider status, and approved DNS configuration. Do not replace a hostname with a numeric address unless the provider documents that approach; it can break endpoint identity and routing.

Record only "resolved" or the error type, not the resulting private address.

## Separate connection outcome

A timeout can indicate filtering, routing, a sleeping service, or unavailable network path. A refusal can indicate that no service accepts the requested connection at that host and port. Neither proves invalid credentials because authentication may not have occurred.

Avoid repeated rapid retries. One timestamped result and a later controlled comparison are more useful.

Respect any provider rate limits and maintenance notices.

## Respect transport identity

If the client reports an invalid, mismatched, expired, or untrusted certificate, stop and verify with the source provider. Do not disable validation, accept an unexplained certificate, or switch to an insecure scheme as a workaround.

Transport identity protects against connecting to the wrong endpoint.

## Interpret HTTP responses carefully

HTTP status codes describe response semantics, but an endpoint can return an error while remaining reachable. A redirection, client error, server error, or authentication challenge should be compared with provider documentation.

RFC 9110 defines HTTP semantics; it does not describe a specific source's correct endpoint.

## Test authentication separately

Only after endpoint identity is trusted should authorized credentials be entered through the official Norva flow. The [credential-entry guide](/blog/credential-entry-error-without-exposure/) separates wrong field, keyboard, account, expired credential, and provider-side rejection.

Never place credentials in command history or screenshots.

## Compare one controlled alternative

If allowed, compare another authorized supported device on the same network or the same device on another authorized network. Change only one variable and record the difference. The [one-source-at-a-time guide](/blog/connect-one-source-at-a-time/) applies the same isolation principle to configuration.

## Original evidence: layered source reachability trace

| Layer | Result | Next owner |
| --- | --- | --- |
| Address syntax | Pass or error type | User or provider docs |
| Device time | Automatic and correct | Device owner |
| Name resolution | Resolved or error type | Network or source provider |
| Connection | Open, timeout, refused | Network or source provider |
| Transport identity | Trusted or warning type | Source provider |
| HTTP response | Status class, no body secrets | Source provider |
| Authentication | Not tested or exact result | Account owner |
| Controlled comparison | One changed variable | Relevant owner |

## Common mistakes and limitations

- Treating syntax success as reachability.
- Testing from an unrelated network only.
- Replacing a hostname with an address by guesswork.
- Bypassing a certificate warning.
- Calling every HTTP error "offline."
- Putting credentials in a command or screenshot.
- Running scans or repeated aggressive requests.

## Frequently asked questions

### Does an authentication error mean the source is reachable?

It often indicates that an endpoint responded, but verify endpoint identity and provider semantics before drawing a firm conclusion.

### Should I ignore a certificate warning on my own source?

No. Ownership does not make an unexplained identity warning safe; stop and verify the configuration through trusted documentation.

### Can Norva support test my private credentials?

Do not send credentials. Provide masked endpoint structure, exact error, timestamps, versions, and authorized test results instead.

## Your next step

[Open Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [RFC Editor: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
