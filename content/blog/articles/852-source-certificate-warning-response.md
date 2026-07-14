---
content_id: "NVB-852"
title: "What to Do When a Source Connection Shows a Certificate Warning"
seo_title: "Respond Safely to a Source Certificate Warning"
meta_description: "Respond to a certificate warning by stopping, checking time and address, verifying identity with the provider, preserving evidence, and avoiding bypasses."
slug: "source-certificate-warning-response"
canonical_url: "https://norva.tv/blog/source-certificate-warning-response/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "transport-security-response-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should I do when a source connection shows a certificate warning?"
supporting_questions:
  - "Which time, hostname, certificate, network, and provider facts should be checked?"
  - "Why should validation never be bypassed to restore access?"
audience:
  - "Norva users seeing source identity warnings"
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
excerpt: "A certificate warning is an endpoint-identity failure that requires a stop, redacted evidence, clock and address checks, and provider verification before any reconnection."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/validate-source-address-format/"
  - "/blog/check-source-reachability-before-adding/"
  - "/blog/source-connection-timeout-triage/"
cta:
  label: "Use Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "security"
sources:
  - "https://norva.tv/support"
  - "https://www.rfc-editor.org/rfc/rfc5280"
  - "https://www.cisa.gov/secure-our-world"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "certificate warning evidence trace"
  summary: "A trace records timestamp, device and app versions, masked host, exact warning class, device clock, network, expected identity, provider status, certificate name and dates when safely visible, comparison, escalation, and resolution."
  methodology: "The user stops before credential entry, captures only non-secret warning metadata, verifies address and time, consults the source owner through a trusted channel, never disables validation, and retests only after documented resolution."
  asset_urls: []
---

# What to Do When a Source Connection Shows a Certificate Warning

> **In short:** Stop before entering credentials or accepting the connection. Record the warning, timestamp, device and application versions, network, and masked host. Check automatic date and time, compare the address with trusted source documentation, and ask the source owner or provider to verify the certificate identity and service status. Never disable certificate validation, install an unknown certificate, switch to an insecure scheme, or accept a mismatch merely because the source worked previously.

A certificate helps a client authenticate the endpoint in a protected connection. A warning means that validation could not establish the expected trust or identity under current conditions.

## Stop and preserve the warning class

Do not click through. Record whether the message describes a name mismatch, expiry, future validity, untrusted issuer, incomplete chain, revocation, or another failure. Capture a redacted image only if it contains no source credentials, full private address, notifications, or personal details.

Do not post the certificate or endpoint publicly by default.

## Check device time

An incorrect clock can make a valid certificate appear expired or not yet valid. Enable automatic date, time, and timezone through the trusted device platform, then restart the application once.

If the clock repeatedly changes, fix the device problem before source testing.

## Verify the source address

Use the [address-format guide](/blog/validate-source-address-format/) to compare scheme, hostname, port, and path with current provider documentation. A look-alike hostname or copied typo can lead to an unexpected certificate.

Do not replace the hostname with a numeric address; name validation and routing may depend on the documented host.

## Verify through an independent channel

Contact the source owner or provider using a known official portal, phone number, or previously trusted channel. Do not use contact information displayed on the warning page itself. Ask whether maintenance, certificate renewal, hostname migration, or an incident is active.

A provider explanation should identify the expected endpoint without asking for your credential.

## Compare one trusted environment

If authorized, check the same documented endpoint from another updated supported device on the same trusted network, changing only the device. A warning everywhere suggests an endpoint or shared network issue; one-device behavior suggests local trust, time, or interception differences.

Do not perform broad probing. The [reachability guide](/blog/check-source-reachability-before-adding/) keeps the comparison layered.

## Avoid unsafe fixes

Never disable certificate checks, install a profile or root certificate from an unknown party, use an insecure scheme, ignore hostname mismatch, or share credentials to let someone test. Those actions remove the protection the warning is providing.

CISA advises recognizing suspicious prompts and maintaining updated software.

## Resume only after resolution

Retest after the provider documents a fix, the trusted address is corrected, or the local clock or trust store is repaired. Record the certificate identity and validity metadata only where safe and useful. Confirm the warning is gone before credential entry.

If a timeout replaces the warning, use the [timeout triage](/blog/source-connection-timeout-triage/) as a separate incident.

After a clean retest, remove temporary certificate screenshots and close any provider case only when the expected endpoint is documented. Keep a minimal incident date and resolution if it supports maintenance. Review devices that accepted earlier exceptions and remove those exceptions through official platform controls.

## Original evidence: certificate warning evidence trace

| Field | Safe evidence | Result |
| --- | --- | --- |
| Warning | Exact class, redacted |  |
| Time | Timestamp and automatic clock |  |
| Endpoint | Masked documented host |  |
| Device | Model, system, app version |  |
| Network | Trusted context, no address |  |
| Certificate | Name and dates if safely visible |  |
| Provider | Official status or case |  |
| Comparison | One authorized device |  |
| Resolution | Documented fix and clean retest |  |

## Common mistakes and limitations

- Entering credentials after the warning.
- Accepting a mismatch because it worked before.
- Disabling validation or changing to an insecure scheme.
- Installing an unknown root certificate.
- Replacing the hostname with a numeric address.
- Contacting support through the warning page.
- Publishing full endpoint details.

## Frequently asked questions

### Can I accept the warning on a source I own?

No. Ownership does not prove the endpoint identity shown; verify configuration and certificate status through trusted channels first.

### Can the device clock cause a warning?

Yes. Incorrect date or time can affect validity checks, but clock correction does not resolve hostname or trust-chain problems.

### Should I send my password so the provider can test?

No. Provide warning type, masked host, timestamps, and versions; the provider should not need your reusable credential.

## Your next step

[Use Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [RFC Editor: Internet X.509 Certificate and CRL Profile](https://www.rfc-editor.org/rfc/rfc5280)
- [CISA: Secure Our World](https://www.cisa.gov/secure-our-world)
