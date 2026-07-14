---
content_id: "NVB-844"
title: "How to Validate a Source Address Before Saving It"
seo_title: "Validate a Media Source Address Before Saving"
meta_description: "Validate a source address by checking scheme, host, port, path, whitespace, encoding, provider instructions, and embedded credentials before saving."
slug: "validate-source-address-format"
canonical_url: "https://norva.tv/blog/validate-source-address-format/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "address-validation-guide"
topic_cluster: "Source Connection Setup"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How can I validate a media source address before saving it?"
supporting_questions:
  - "Which URL components and copying errors should be checked?"
  - "Why do valid format, reachability, identity, and authentication require separate tests?"
audience:
  - "Norva users entering a compatible source address"
  - "Support teams documenting source setup errors"
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
excerpt: "Address validation confirms structure and provider-specific requirements without making a network request, proving endpoint identity, or testing credentials."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/authorized-source-connection-planning-guide/"
related_articles:
  - "/blog/collect-source-details-securely/"
  - "/blog/check-source-reachability-before-adding/"
  - "/blog/credential-entry-error-without-exposure/"
cta:
  label: "Use Norva's Official Support"
  href: "https://norva.tv/support"
  intent: "support"
sources:
  - "https://norva.tv/support"
  - "https://www.rfc-editor.org/rfc/rfc3986"
  - "https://developer.mozilla.org/en-US/docs/Learn_web_development/Howto/Web_mechanics/What_is_a_URL"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "source address syntax review sheet"
  summary: "A sheet records masked original, expected scheme, host form, port, path, query presence, trailing requirement, whitespace, encoding, embedded-secret check, source documentation, parser result, and next reachability test."
  methodology: "The reviewer works with a masked copy, compares current provider instructions, uses a standard URL parser without sending the request, avoids normalization that changes meaning, and treats syntax success as only one gate."
  asset_urls: []
---

# How to Validate a Source Address Before Saving It

> **In short:** Compare the address with current source-provider instructions, using a masked copy for notes. Check the expected scheme, host, optional port, path, query, trailing characters, capitalization where relevant, whitespace, and encoded characters. Reject embedded usernames, passwords, tokens, line breaks, and look-alike hostnames. A standard parser can confirm syntax without sending a request. Valid format does not prove reachability, endpoint identity, authorization, certificate safety, or correct credentials; test those layers separately.

A source address is generally a Uniform Resource Identifier or URL-like value identifying an endpoint. RFC 3986 defines generic URI syntax, while the source provider can impose additional path and field requirements.

## Start with authoritative text

Copy the address from the source owner's official account page or provider documentation, not a forum or screenshot. Confirm that the owner authorized its use.

The [secure source-details guide](/blog/collect-source-details-securely/) protects private endpoint structure and credentials during collection.

## Remove copying artifacts

Check leading and trailing spaces, hidden line breaks, smart quotes, punctuation copied from prose, and characters visually similar to ordinary letters. Paste first into a trusted plain-text view that does not synchronize publicly.

Do not use an online URL checker for a private source address; it would disclose the value to another service.

## Inspect the scheme

Confirm the provider-required scheme exactly. Do not add or remove transport security merely to make validation pass. A certificate warning or unsupported scheme is not a formatting problem to bypass.

Avoid assuming that an address without a visible scheme will be completed correctly by the application.

## Inspect host, port, and path

Confirm hostname or authorized numeric address, port when explicitly required, and exact path. Hostnames are not generally case-sensitive, while path behavior can be case-sensitive depending on the server. Do not normalize path case.

Check whether the provider requires or forbids a trailing slash or a specific endpoint path.

## Inspect query and encoded characters

Question marks, ampersands, percent encodings, and fragments have defined structural roles. Do not decode, reorder, or remove them unless current provider guidance says to. A harmless-looking change can alter endpoint meaning.

Never include a password or token in a query for convenience.

## Exclude embedded credentials

Addresses can technically contain user-information components, but placing reusable credentials in a URL creates history, log, screenshot, and sharing risks. Use separate secure credential fields when the current setup supports them.

If official source documentation appears to require a secret-bearing address, request secure handling guidance before proceeding.

## Use a local parser, not a request

A standards-based parser can reveal missing scheme, invalid port, malformed encoding, or component boundaries without contacting the endpoint. Record only pass, fail, and masked structure.

Parser acceptance does not verify that the host belongs to the expected provider.

Record the parser name and version when reproducibility matters. Different tools may accept shorthand or normalize characters differently, so compare the preserved masked original with the value that Norva will save.

## Move to reachability and authentication

After syntax passes, follow the [reachability guide](/blog/check-source-reachability-before-adding/) from an authorized device and network. Then enter credentials privately. If authentication fails, use the [credential-error guide](/blog/credential-entry-error-without-exposure/) rather than changing address components randomly.

## Original evidence: source address syntax review sheet

| Component | Expected | Observed safely | Result |
| --- | --- | --- | --- |
| Scheme | Provider-documented | Masked |  |
| Host | Authorized provider host | Partially masked |  |
| Port | Explicit or default | Number only |  |
| Path | Exact documented path | Structure only |  |
| Query | Only if required | Names, no values |  |
| Whitespace and encoding | Valid and intentional | Pass or fail |  |
| Embedded secrets | None | Pass or stop |  |
| Local parser | Accepts syntax | Pass or error type |  |

## Common mistakes and limitations

- Sending a private address to an online checker.
- Adding a scheme or port by guesswork.
- Lowercasing a case-sensitive path.
- Removing encoded characters or trailing requirements.
- Embedding credentials in the URL.
- Bypassing a certificate warning.
- Treating parser success as reachability or authorization.

## Frequently asked questions

### Does a valid URL mean the source works?

No. Syntax, endpoint identity, reachability, authorization, transport security, and authentication are separate gates.

### Can I paste the address into a public validator?

Avoid doing so for private endpoints. Use a trusted local parser and masked notes instead.

### Should I fix a certificate warning by changing the scheme?

No. Stop and verify the endpoint and provider guidance; do not bypass or disguise an identity or security warning.

## Your next step

[Use Norva's Official Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [RFC Editor: Uniform Resource Identifier syntax](https://www.rfc-editor.org/rfc/rfc3986)
- [MDN: What is a URL?](https://developer.mozilla.org/en-US/docs/Learn_web_development/Howto/Web_mechanics/What_is_a_URL)
