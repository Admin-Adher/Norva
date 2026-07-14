---
content_id: "NVB-439"
title: "Build a Device-to-Device Handoff Test Matrix"
seo_title: "Build a Device-to-Device Handoff Test Matrix"
meta_description: "Design a controlled handoff matrix for supported device pairs, standard media states, pass criteria, privacy-safe evidence, and reproducible follow-up."
slug: "build-a-device-to-device-handoff-test-matrix"
canonical_url: "https://norva.tv/blog/build-a-device-to-device-handoff-test-matrix/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Cross-Device Handoff"
search_intent: "cross-device handoff test matrix"
funnel_stage: "retention"
primary_question: "How can I build a useful device-to-device handoff test matrix?"
supporting_questions:
  - "Which device pairs should I prioritise?"
  - "What counts as a handoff pass?"
audience:
  - "Households validating regular device pairs"
  - "Support-minded users documenting handoff behaviour"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Design a controlled handoff matrix for supported device pairs, standard media states, pass criteria, privacy-safe evidence, and reproducible follow-up."
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
parent_pillar: "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
related_articles:
  - "/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/"
  - "/blog/how-to-document-a-cross-device-handoff-failure/"
  - "/blog/a-cross-device-handoff-readiness-checklist/"
cta:
  label: "Review Norva's Cross-Device Experience"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "device-pair test matrix template"
  summary: "A reusable matrix defines pair priority, fixed test state, pass criteria, controlled variables, and evidence without inventing benchmark results."
  methodology: "Readers select only supported pairs they use, run the same harmless media-state sequence, and record observed pass, partial, or fail outcomes."
  asset_urls: []
---
# Build a Device-to-Device Handoff Test Matrix

> **In short:** List only supported device pairs you genuinely use, then give every pair the same harmless test state: account, profile, authorised source, item, version, position, audio, and subtitles. Define pass criteria before testing, change no extra variables, and record pass, partial, or fail with evidence. The matrix documents your environment; it is not a universal compatibility chart.

A matrix is useful when a household moves between several screens or when a failure appears on one route but not another. It prevents random tests from producing incomparable results.

## Inventory supported endpoints

Write each device by role rather than brand claim:

- living-room TV source;
- tablet target;
- mobile source;
- compatible-browser target;
- second supported TV.

Confirm that each endpoint currently opens Norva. Do not include a device simply because it has a browser or screen.

## Prioritise real routes

Rank pairs by frequency and consequence. A nightly TV-to-tablet route deserves attention before a hypothetical pair nobody uses. Avoid testing every possible direction at once; source-to-target and target-to-source may have different local states.

The [cross-device handoff guide](/blog/a-state-by-state-guide-to-cross-device-viewing-handoff/) defines the common state layers.

## Choose one standard test state

Select an authorised, non-sensitive item with clear identity, a visible version label, and known available tracks. Record a short starting position. Do not choose a finale, a private title, or media whose availability is uncertain.

Keep the same profile and network condition for the first pass.

## Define pass criteria first

A pass requires:

- intended account and profile;
- exact item and version;
- plausible recorded position;
- intended available audio and subtitles;
- verified target output;
- usable pause and return controls;
- clean source close or pause;
- no unexpected exposure on shared screens.

“Looks fine” is not a criterion. Write the observable state.

## Build directional rows

A pair needs one row per direction. TV-to-tablet is not the same row as tablet-to-TV because input, output, posture, and privacy differ.

The [handoff readiness checklist](/blog/a-cross-device-handoff-readiness-checklist/) provides a compact preflight for each run.

## Run one pair at a time

1. Reset to the documented source state.
2. Pause and record position.
3. Open the target.
4. Verify prerequisites.
5. Resume once.
6. Confirm state.
7. Close or pause both screens.
8. Record the result before changing devices.

Do not clear data or reinstall between ordinary rows. Those are separate recovery experiments.

## Original evidence: matrix

| Source | Target | Profile | Item/version | Position | Tracks | Output | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  | Pass / Partial / Fail |
|  |  |  |  |  |  |  | Pass / Partial / Fail |
|  |  |  |  |  |  |  | Pass / Partial / Fail |

Add columns for app versions, date, time zone, and network condition when troubleshooting. “Partial” means identity succeeds but another required state needs manual correction.

## Attach evidence safely

Use concise notes or a redacted screenshot. Remove account email, source credentials, private URLs, payment data, profile names, and unrelated notifications.

A failure row should link to [the support-ready handoff report](/blog/how-to-document-a-cross-device-handoff-failure/) rather than accumulating an oversized unstructured recording.

## Interpret without overclaiming

One passing pair proves only that the documented workflow worked in that environment at that time. It does not establish support for every device or guarantee future performance.

One failing pair identifies a condition for investigation, not a universal outage.

## Common mistakes and limitations

Avoid mixing app versions without recording them, changing media between rows, treating directions as identical, testing unsupported endpoints, and presenting personal results as product benchmarks.

Source availability, rights, networks, devices, and updates can change. Repeat only the high-value rows after a material change or observed issue.

## Keep unsupported cells visible

Mark an unsupported or unverified route as such instead of leaving its matrix cell blank; a blank cell can be mistaken for an unrun supported test.

## Frequently asked questions

### How many pairs should the first matrix include?

Start with the routes you actually use. A small complete matrix is more useful than a large unfinished one.

### Should I measure handoff time?

Only with a defined method and repeated observations. This basic matrix focuses on state correctness, not invented performance targets.

### Can I share the matrix with support?

Yes after removing sensitive data and expanding any failure into exact reproducible steps.

## Your next step

[Review Norva's cross-device experience](https://norva.tv/#how-it-works)

## Sources

- [W3C: Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)
- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Support](https://norva.tv/support)
