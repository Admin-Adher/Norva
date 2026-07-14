---
content_id: "NVB-297"
title: "How to Document a Continue Watching Problem for Support"
seo_title: "Document a Continue Watching Problem for Support"
meta_description: "Create a useful Continue Watching support report with expected and observed results, exact item identity, profile, device, timestamped steps, cropped evidence, and privacy checks."
slug: "document-resume-row-issue"
canonical_url: "https://norva.tv/blog/document-resume-row-issue/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "support guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should a Continue Watching problem be documented for support?"
supporting_questions:
  - "Which facts make a resume-row issue reproducible?"
  - "Which sensitive details should be excluded?"
audience:
  - "Norva users preparing a support request"
  - "Reviewers validating a resume-row issue"
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
  source_of_truth: "https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A privacy-conscious support packet that replaces “it is broken” with an exact timeline, identity context, expected result, observed result, and clean reproduction."
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
parent_pillar: "/blog/continue-watching-hygiene-guide/"
related_articles:
  - "/blog/completed-title-still-in-progress/"
  - "/blog/wrong-episode-in-resume-row/"
  - "/blog/resume-row-differs-between-screens/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc3339"
  - "https://pages.nist.gov/800-63-4/sp800-63b.html"
  - "https://norva.tv/privacy"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "privacy-minimised resume issue report template"
  summary: "A fillable report captures summary, expected result, observed result, exact identity, environment, timestamped steps, frequency, evidence, and redaction status."
  methodology: "Readers reproduce once with a harmless item where possible, record only necessary context, crop evidence, remove credentials and unrelated history, and submit through the verified support route."
  asset_urls: []
---

# How to Document a Continue Watching Problem for Support

> **In short:** Report one precise symptom with expected and observed results. Include the exact title, episode and version, active profile, supported device category, connectivity, visible product version, timestamped steps, and whether the issue reproduces. Crop screenshots to the relevant state and remove passwords, source credentials, account secrets, and unrelated viewing history.

A strong support request lets another person understand the issue without guessing. “Continue Watching is wrong” describes frustration; “the row opened season 1 episode 6 after a controlled completion of season 2 episode 3” describes a testable mismatch.

## Use the eight-part report

1. **One-line summary:** one symptom, one context.
2. **Expected result:** what should have appeared or opened.
3. **Observed result:** exactly what appeared or opened.
4. **Media identity:** work, season, episode, edition, source context, language, and duration where relevant.
5. **Environment:** device category, browser or app version if visible, account and non-sensitive profile label, connectivity.
6. **Timestamped steps:** shortest clean reproduction.
7. **Frequency:** once, intermittent, or reproducible under the documented conditions.
8. **Evidence and redaction:** cropped images or a text table, checked for private data.

Use RFC 3339-style timestamps with offsets when two screens or offline events are involved.

## Write expected and observed statements

Avoid emotional or causal language. A useful pair is:

> Expected: After reaching the declared endpoint of S2:E3 on profile A, the resume card would reference the source-defined next episode.

> Observed: At 2026-07-14T20:18:00+02:00, the card displayed S1:E6 and opened that episode.

Do not state that synchronization “lost” data unless you can prove loss. Describe the visible difference.

Use [the wrong-episode workflow](/blog/wrong-episode-in-resume-row/), [completed-title diagnostic](/blog/completed-title-still-in-progress/), or [two-screen comparison](/blog/resume-row-differs-between-screens/) to produce a clean event sequence before reporting.

## Reduce the reproduction

Start from a captured baseline. Reproduce once on one profile, item, version, and device. Stop after the first unexpected result. Multiple retries can overwrite useful state and create a confusing timeline.

List each action as an observable step: “Opened Continue Watching,” “selected card labelled…,” “played to declared endpoint,” “exited with…,” “reopened row.” Do not speculate about servers, databases, or internal algorithms.

## Protect sensitive information

Never send a password, authentication code, payment detail, source credential, private URL containing secrets, or complete household history. NIST authentication guidance treats passwords and other authentication secrets as protected information; support evidence should not contain them.

Crop screenshots to the affected card and necessary context. Replace a personal profile name with “Profile A” in the written report unless support specifically requires the actual label through a verified private channel. Review Norva’s [privacy information](https://norva.tv/privacy) before sharing diagnostic material.

## Include the evidence that changes diagnosis

Useful evidence distinguishes versions, profiles, episodes, screens, or event order. A decorative screenshot of the whole page adds little. Prefer:

- before-and-after card crops;
- a two-column version comparison;
- a completion checkpoint;
- a timestamped offline-to-connected timeline;
- exact labels copied as text;
- visible product version where available.

State the limit of each asset. A screenshot proves what was displayed at one moment, not why it happened.

## Original evidence: report template

Copy the eight headings into a private document and complete them for one harmless issue. Ask a second reviewer to reproduce the expected-versus-observed sequence from the report alone. If they ask which profile, version, or timestamp applied, add that field.

The template makes reports comparable and privacy-conscious. It does not guarantee a resolution or response time.

## Common mistakes and limitations

- Sending “does not work” without an expected result.
- Omitting episode or version identity.
- Reproducing repeatedly before preserving the first state.
- Including full-screen household history.
- Sending credentials or authentication secrets.
- Claiming a root cause from one visible symptom.
- Combining unrelated problems in one report.

Support may request additional current-build information through the verified channel. Follow those instructions without publishing private details in a public article or forum.

## Frequently asked questions

### Should I attach a video?

Only when it adds necessary event order and can be cropped or edited to remove private information. A concise table is often sufficient.

### How many examples should I include?

Start with one clean reproduction. Add a second only when it demonstrates a distinct condition.

### Can I anonymise the title?

Support may need exact media identity to compare versions. Share it privately when necessary, but remove unrelated history and secrets.

## Your next step

[Contact Norva Support](https://norva.tv/support)

## Sources

- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [NIST SP 800-63B: Authentication and Authenticator Management](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [Norva Privacy Policy](https://norva.tv/privacy)
- [Norva Support](https://norva.tv/support)
