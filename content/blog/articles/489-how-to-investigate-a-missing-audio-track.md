---
content_id: "NVB-489"
title: "How to Investigate a Missing Audio Track"
seo_title: "How to Investigate a Missing Audio Track"
meta_description: "Investigate a missing audio track by preserving the baseline, verifying item and version, comparing one context at a time, and preparing a privacy-safe report."
slug: "how-to-investigate-a-missing-audio-track"
canonical_url: "https://norva.tv/blog/how-to-investigate-a-missing-audio-track/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting-guide"
topic_cluster: "Audio Track Management"
search_intent: "missing audio track diagnostic"
funnel_stage: "retention"
primary_question: "How should a viewer investigate an expected audio track that is missing?"
supporting_questions:
  - "Which source, item, version, episode, device, and offline contexts should be compared?"
  - "What evidence belongs in a support report?"
audience:
  - "Viewers missing a language or accessibility track"
  - "People preparing audio-track support evidence"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/terms; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 6
excerpt: "A one-variable diagnostic for locating an expected audio track across item, version, episode, device, and offline contexts without destructive changes."
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
parent_pillar: "/blog/the-complete-guide-to-managing-audio-tracks/"
related_articles:
  - "/blog/the-complete-guide-to-managing-audio-tracks/"
  - "/blog/how-version-changes-can-affect-available-audio-tracks/"
  - "/blog/how-offline-availability-can-affect-audio-track-choices/"
cta:
  label: "Contact Norva Support With Your Evidence"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/#how-it-works"
  - "https://www.w3.org/TR/media-accessibility-reqs/"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "missing-track diagnostic tree"
  summary: "A diagnostic tree separates absence in the selected media, metadata ambiguity, version variance, device exposure, and online-versus-local context before escalation."
  methodology: "The viewer records the complete baseline, verifies the expectation source, changes one context at a time, stops before destructive actions, and reports the narrowest reproducible difference."
  asset_urls: []
---
# How to Investigate a Missing Audio Track

> **In short:** Record the complete audio list, source, item, media version, episode, profile, device, app or browser version, and online or eligible offline state. Verify why you expect the track, then compare one known context at a time. Do not remove the source, clear data, reinstall, reset, or change credentials. Report the smallest reproducible difference.

“Missing” means an expected option is not visible in a specific context. It does not yet identify whether the selected media lacks it, metadata hides it, another version contains it, or the current device exposes it differently.

## Verify the expectation

Write down the evidence behind the expectation:

- the track was previously visible on the same item and version;
- another episode in the same season exposes it;
- another version lists it;
- the source owner has current authoritative information;
- a support response says it should be available.

Memory alone is a starting hypothesis. Avoid relying on an unrelated release or another source's catalogue.

## Preserve the baseline

Capture every visible audio entry and selected marker before changing anything. Add:

- account and anonymised profile;
- source and item identifier;
- season and episode where relevant;
- exact media version;
- device and app or browser version;
- output route;
- connectivity and offline status;
- local date and time zone.

Redact source addresses, credentials, private history, and unrelated profiles.

## Check for an ambiguous label

The expected role may be present under a broad language label. Sample only plausible candidates and use the audio-list reading method. Do not treat every same-language entry as the missing track.

If the role can be heard but the label is wrong or unclear, the problem is metadata usability rather than absence.

## Compare the media version

Confirm the selected version before and after navigation. Use [the version-change audio guide](/blog/how-version-changes-can-affect-available-audio-tracks/) to compare lists without changing device or profile.

If one version contains the expected track and another does not, record that boundary. Do not claim why the versions differ unless the source provides authoritative information.

## Compare one adjacent context

Choose the comparison most likely to answer the question:

- neighboring episode, for a season pattern;
- same item on another supported device, for exposure differences;
- same device with the online item, for an eligible offline-copy question;
- same item after reopening, for transient selector state.

Change only one variable. The [offline audio-choice guide](/blog/how-offline-availability-can-affect-audio-track-choices/) explains how to compare local and connected contexts carefully.

## Original evidence: diagnostic tree

Record each branch:

| Branch | Test | Result | Interpretation status |
|---|---|---|---|
| Label | Sample candidate | Heard role or not | Verified/unclear |
| Version | Compare exact versions | Lists differ or match | Observed |
| Episode | Compare neighbor | Present or absent | Observed |
| Device | Same media elsewhere | Present or absent | Observed |
| Offline | Connected vs local | Lists differ or match | Observed |

The table describes differences; it does not assign a root cause automatically.

## Stop before destructive changes

Do not sign out, remove a source, delete a profile, clear storage, reinstall, reset a device, or change credentials merely to search for a track. Such actions can erase evidence and create unrelated failures.

Use [the complete audio-management guide](/blog/the-complete-guide-to-managing-audio-tracks/) for a safe baseline and contact the appropriate source owner or Norva support when the comparison points to the player context.

## Prepare the report

State the exact missing label or role, why it is expected, complete list observed, steps, expected and observed result, and one controlled comparison. Include privacy-safe screenshots where authorised, but not the media itself.

## Common mistakes and limitations

Avoid comparing different versions unknowingly, assuming labels are complete, changing several variables, and calling a season-wide failure from one episode.

Norva cannot supply an alternative absent from the selected media. Current source metadata and supported player controls determine what can be exposed.

## Frequently asked questions

### Can a track disappear because I changed versions?

The available list can differ by media version. Compare exact versions while holding other context steady.

### Should I reinstall the app first?

No. Preserve evidence and use non-destructive comparisons before any support-authorised disruptive action.

### What if the track exists but has the wrong label?

Document the verified role and exact misleading label, then use the mislabeled-track reporting workflow.

## Your next step

[Contact Norva Support with your evidence](https://norva.tv/support)

## Sources

- [Norva Support](https://norva.tv/support)
- [Norva: How It Works](https://norva.tv/#how-it-works)
- [W3C: Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)
