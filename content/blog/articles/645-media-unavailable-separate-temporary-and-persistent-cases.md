---
content_id: "NVB-645"
title: "Media Unavailable: Separate Temporary and Persistent Cases"
seo_title: "Media Unavailable: Temporary or Persistent?"
meta_description: "Separate temporary and persistent media-unavailable messages by version, source, time, scope, status evidence, device, network, spaced retries, and recovery."
slug: "media-unavailable-separate-temporary-and-persistent-cases"
canonical_url: "https://norva.tv/blog/media-unavailable-separate-temporary-and-persistent-cases/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "availability-error-diagnostic"
topic_cluster: "Playback Error Diagnostics"
search_intent: "media unavailable state diagnostic"
funnel_stage: "retention"
primary_question: "How can temporary and persistent media-unavailable cases be separated?"
supporting_questions: []
audience: []
author:
  name: ""
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
  source_of_truth: "https://norva.tv/; https://norva.tv/support; https://norva.tv/privacy; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "Record the exact message, authorised title and version, source, first and last occurrence, spaced retries, official status notices, device, network, account-safe state, and whether other titles work. “Temporary” means the state later changes under comparable conditions; “persistent” means it recurs across a defined observation window, not forever."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "availability recurrence and scope calendar"
  summary: "A calendar records exact title version and source, message, first and last occurrence, spaced retries, status notices, device and network scope, alternate titles, recovery, and official availability definition."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/how-to-read-a-playback-error-before-trying-a-fix/"
related_articles:
  - "/blog/how-to-read-a-playback-error-before-trying-a-fix/"
  - "/blog/session-expired-during-playback-what-to-verify/"
  - "/blog/how-to-investigate-an-unsupported-media-message/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc9110"
  - "https://www.w3.org/TR/media-source-2/"
  - "https://www.rfc-editor.org/rfc/rfc6973"
---
# Media Unavailable: Separate Temporary and Persistent Cases

> **In short:** Record the exact message, authorised title and version, source, first and last occurrence, spaced retries, official status notices, device, network, account-safe state, and whether other titles work. “Temporary” means the state later changes under comparable conditions; “persistent” means it recurs across a defined observation window, not forever.

An unavailable label can refer to source state, version selection, authorization, policy, endpoint response, or app interpretation. Preserve uncertainty.

## Verify the exact media entry

Record title edition, duration, version group, source, quality, tracks, subtitles, and any availability label. Two entries with the same title can point to different versions or sources.

Norva organises compatible sources users own or are authorised to access; it does not supply or guarantee a catalogue.

## Capture the message and phase

Transcribe text, code, language, buttons, wall time, time zone, and whether it appears during browse, source selection, startup, seek, or resume. [Read the error before fixing it](/blog/how-to-read-a-playback-error-before-trying-a-fix/).

Do not map a friendly message to an HTTP status without validated logs or official documentation.

## Define an observation window

Choose a reasonable, non-disruptive retry schedule based on official guidance. Record first occurrence, spaced retries, and recovery. Avoid continuous refreshes that create load or account limits.

Persistent describes the observed window only; include its start and end.

## Original evidence: availability calendar

| Date/time | Version/source | Device/network | Message/code | Other titles | Official status | Retry/recovery |
|---|---|---|---|---|---|---|
| First event | Context | Context | Verbatim | Result | Notice/none | Action |
| Spaced retry | Same | Same | Result | Result | Evidence | Action |
| Comparison | Alternate version | Same | Result | Result | Evidence | Action |
| Final check | Context | Context | Result | Result | Evidence | Recovered/persistent |

Use abstract source and device labels; omit account data, URLs, tokens, and addresses.

## Test scope by title and source

Compare another authorised title from the same source, the same title from another authorised version where available, and another source entry. Keep device, network, and time stable.

If one version alone is unavailable, version-specific source state becomes relevant. If every title from one source fails, session or source scope gains relevance.

## Test device and network scope

Try another supported device and one trusted network without changing account and source simultaneously. If the same entry fails everywhere, local device or Wi-Fi becomes less likely. It still does not prove permanent removal.

Repeat the normal device and network after each comparison. A result that changes only once may reflect time rather than the tested layer. Record app and operating-system versions so platform-specific availability or session behavior remains visible.

[Session expiry needs separate verification](/blog/session-expired-during-playback-what-to-verify/) if sign-in or authorization messages appear.

## Check official status evidence

Timestamp source, app, and provider status notices and record their scope. Absence of a notice does not prove individual availability. A notice about another region or product should not be applied to this case.

RFC 9110 defines HTTP response semantics, including temporary service conditions, but only validated technical evidence can connect a user-facing message to them.

## Separate unavailable from unsupported

An unavailable source state differs from a device that cannot handle the offered media. [The unsupported-media guide](/blog/how-to-investigate-an-unsupported-media-message/) compares media capability and alternate versions.

If an alternate compatible version plays, preserve both availability and capability hypotheses until official evidence clarifies them.

## Escalate without overclaiming

Provide exact entry context, message, calendar, comparison titles, devices, networks, status notices, session state, recovery, and unknowns. Use official trusted channels and follow RFC 6973 privacy considerations by minimizing disclosed data.

Do not report “removed permanently” unless the authorised source officially states it.

## Close the observation window

At the planned endpoint, classify the case as recovered, still unavailable, changed message, or inconclusive. Do not keep retrying indefinitely or rewrite the original first-observed time.

## Frequently asked questions

### How long makes an error persistent?

There is no universal duration. Define the observation window and follow official retry or status guidance.

### Does another title working prove the network is fine?

No. Endpoints, versions, delivery patterns, and authorization can differ.

### Should the source entry be deleted and re-added?

Not early. That can erase version and state evidence; follow official support after documenting the case.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [W3C Media Source Extensions](https://www.w3.org/TR/media-source-2/)
- [RFC 6973: Privacy Considerations](https://www.rfc-editor.org/rfc/rfc6973)