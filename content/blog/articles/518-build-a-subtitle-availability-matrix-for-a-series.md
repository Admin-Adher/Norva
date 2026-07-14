---
content_id: "NVB-518"
title: "Build a Subtitle Availability Matrix for a Series"
seo_title: "Build a Subtitle Availability Matrix for a Series"
meta_description: "Build a series subtitle matrix recording episode, version, complete track list, verified role, cue coverage, timing, starting state, exceptions, and support evidence."
slug: "build-a-subtitle-availability-matrix-for-a-series"
canonical_url: "https://norva.tv/blog/build-a-subtitle-availability-matrix-for-a-series/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "audit-template"
topic_cluster: "Subtitle Management"
search_intent: "series subtitle availability matrix"
funnel_stage: "retention"
primary_question: "How should a viewer build a subtitle-availability matrix for a series?"
supporting_questions:
  - "Which fields distinguish availability, role, cue coverage, timing, and starting state?"
  - "When should representative sampling expand to every episode?"
audience:
  - "Series viewers planning subtitle or caption access"
  - "People preparing season-wide timed-text evidence"
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
excerpt: "A reusable episode matrix for subtitle availability, exact labels, verified roles, cue coverage, timing, starting state, and outliers."
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
parent_pillar: "/blog/the-complete-guide-to-managing-subtitle-tracks/"
related_articles:
  - "/blog/how-to-check-subtitle-consistency-across-a-series-season/"
  - "/blog/how-to-report-a-mislabeled-subtitle-track/"
  - "/blog/subtitles-early-or-late-build-a-timing-diagnosis/"
cta:
  label: "Contact Norva Support With Your Matrix"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://www.w3.org/TR/webvtt1/"
  - "https://www.w3.org/TR/media-accessibility-reqs/"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "series subtitle availability matrix"
  summary: "A normalized matrix separates episode/version identity, complete track inventory, verified role, target availability, cue coverage, timing, starting state, and exception ownership."
  methodology: "The auditor fixes one device context, samples representative episodes, expands around outliers or access-critical gaps, records unknown values explicitly, and validates roles through cue evidence."
  asset_urls: []
---
# Build a Subtitle Availability Matrix for a Series

> **In short:** Use one row per episode and media version. Record the complete subtitle list, exact target label, verified role, dialogue and role-specific cue coverage, timing observation, starting state, device context, and exception. Begin with representative episodes, expand around outliers, and check every episode when a language or accessibility need must be confirmed.

A matrix turns a vague season complaint into a bounded map. It should show what is available and observed, not guess why an episode differs.

Name one coordinator to preserve field definitions and review contributed rows before conclusions are shared. This avoids one person using “absent” for an untested episode while another uses it only after inspecting the full selector.

## Define one primary target

Examples:

- a preferred language is available;
- captions include relevant audio information;
- a forced track appears where needed;
- signs and songs have usable coverage;
- labels are consistent;
- cues remain reasonably timed;
- the same state starts.

You can record several fields, but interpret the matrix around one target outcome.

## Fix the audit context

Record source, season, account or anonymised profile, device, app or browser version, display context, state, and online or eligible offline status. Use separate rows for alternate media versions.

Do not merge different versions or devices into one episode result.

## Build core columns

| Episode | Version | Full track list | Target present | Role verified | Cue coverage | Timing | Starting state |
|---|---|---|---|---|---|---|---|
| S1E1 | Exact label | Exact entries | Yes/no/unclear | Cue result | Dialogue/role scene | Observation | Exact state/track |

Use “not tested” when a suitable scene is absent and “unknown” when metadata is ambiguous.

## Verify roles with cues

For each target, sample ordinary dialogue and one role-relevant scene. Captions need a non-speech or speaker-identification check; forced tracks need a limited passage; signs-and-songs tracks need visible writing or lyrics.

Do not assign role from list order or language alone.

## Start representative, then expand

Check first, middle, and final episodes. The [season subtitle consistency guide](/blog/how-to-check-subtitle-consistency-across-a-series-season/) explains this as a screen rather than proof.

When an outlier appears, check its neighboring episodes. Audit every episode when the viewer needs access certainty or when the sample reveals repeated gaps.

## Original evidence: exception layer

Create a second table:

| Episode/version | Exception type | Evidence | Owner | Next check | Status |
|---|---|---|---|---|---|
| Exact context | Availability, metadata, coverage, timing, selection, or presentation | Timestamp and screenshot reference | Coordinator/source owner | Action/date | Open/verified |

This keeps the main matrix readable and assigns unresolved work.

## Keep exception types separate

If the target is absent, record availability. If present but mislabeled, record metadata. If cues exist but are early or late, record timing. If another state starts, record selection. If text clips, record presentation.

Use [the timing diagnosis](/blog/subtitles-early-or-late-build-a-timing-diagnosis/) and [the mislabeled-track report](/blog/how-to-report-a-mislabeled-subtitle-track/) for deeper evidence.

## Review matrix quality

Check that:

- episode numbering is consistent;
- every version is named;
- complete labels are preserved;
- target present differs from role verified;
- not tested differs from absent;
- timestamps use the same convention;
- device changes are explicit;
- screenshots contain no secrets or private history.

Do not turn a local sample into a product-wide percentage claim.

## Prepare a support summary

State affected episodes/versions, target role, expected result, observed result, stable device context, and one representative reproduction. Attach the matrix and redacted selector screenshots, not media or subtitle resources.

## Common mistakes and limitations

Avoid treating untested as absent, combining versions, sampling different states unknowingly, and calling three episodes a complete audit.

The matrix documents supplied media and current supported presentation. It cannot guarantee editorial completeness or identify an internal root cause.

## Frequently asked questions

### Must every episode be audited?

Only when the use case requires certainty or sampling reveals gaps. Otherwise expand around outliers.

### Should timing be a numeric field?

Use approximate offsets only when observed reliably; otherwise record usable, issue, or not tested with a timestamp note.

### Can several people maintain the matrix?

Yes, if one coordinator controls definitions and every contributor uses the same context and privacy rules.

## Your next step

[Contact Norva Support with your matrix](https://norva.tv/support)

## Sources

- [Norva Support](https://norva.tv/support)
- [W3C: WebVTT](https://www.w3.org/TR/webvtt1/)
- [W3C: Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)
