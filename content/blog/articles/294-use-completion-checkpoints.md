---
content_id: "NVB-294"
title: "How Completion Checkpoints Improve Resume-Row Accuracy"
seo_title: "Use Completion Checkpoints for Better Resume Accuracy"
meta_description: "Create clear completion checkpoints by recording exact media identity, intended endpoint, viewer, version, exit action, and observed row state before diagnosing a mismatch."
slug: "use-completion-checkpoints"
canonical_url: "https://norva.tv/blog/use-completion-checkpoints/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How do completion checkpoints improve Continue Watching accuracy?"
supporting_questions:
  - "What should a checkpoint record?"
  - "How can a checkpoint distinguish viewer intent from displayed state?"
audience:
  - "Viewers troubleshooting completion state"
  - "Series viewers auditing episode transitions"
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
estimated_reading_minutes: 7
excerpt: "A checkpoint method that turns “I finished it” into a precise, reproducible comparison between intended endpoint and visible resume state."
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
  - "/blog/audit-series-episode-rollover/"
  - "/blog/document-resume-row-issue/"
cta:
  label: "Get Help From Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc3339"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "three-stage completion checkpoint card"
  summary: "A before, endpoint, and after card records identity, profile, version, timestamp, intended completion landmark, exit action, and resulting row state."
  methodology: "Readers capture the baseline, state the intended ending, complete one controlled session, exit normally, and compare the first post-playback observation without imposing a universal threshold."
  asset_urls: []
---

# How Completion Checkpoints Improve Resume-Row Accuracy

> **In short:** A completion checkpoint records what the viewer intended to finish and what the interface displayed before and after playback. Capture exact media identity, profile, version, starting state, intended endpoint, exit action, and timestamp. The checkpoint does not force completion; it gives you evidence to distinguish an unfinished ending, a version mismatch, or a persistent row problem.

“I watched it to the end” is meaningful to the viewer but incomplete for troubleshooting. Which version? Which episode? Which profile? What counted as the intended end? A checkpoint answers those questions without inventing an internal completion rule.

## Build a three-stage card

| Stage | Required fields |
|---|---|
| Before | Account, profile, exact work, episode, version, displayed progress, timestamp |
| Endpoint | Intended ending landmark, reason it represents completion, exit action |
| After | First row observation, card label, opened destination if tested, timestamp |

Use RFC 3339-style timestamps with offsets. DCMI metadata distinctions for identifier, relation, format, and language help establish the exact media entity.

Keep the card private and minimal. Do not record credentials, source secrets, or unrelated viewing history.

## Choose an intended endpoint

An endpoint can be the end of the main programme, an episode boundary, the end of a chapter, or another viewer-defined landmark. State it before the test. Do not claim that credits or a certain percentage universally causes software completion.

For a series, record both the completed episode and the next episode you expect to see. For a film with multiple versions, note the edition and duration. If identity remains unclear, use [the version comparison workflow](/blog/duplicate-versions-in-resume-row/) first.

## Run one clean session

On a confirmed profile and supported device:

1. capture the Before fields;
2. open the exact item;
3. verify language, subtitles, and version where relevant;
4. play through the stated endpoint;
5. exit using the normal available control;
6. reopen Continue Watching once;
7. capture the After fields before further playback.

Avoid switching profiles or devices during the run. Avoid repeated seeks and exits after the endpoint because they add events that obscure the first result.

## Interpret checkpoint outcomes

**Expected state:** the row reflects the viewer’s intended completion or next episode. **Identity mismatch:** the row refers to another version or episode. **Context mismatch:** the active profile or device context changed. **Persistent same-item mismatch:** the exact item still shows an unexpected state after the clean run.

For the last outcome, follow [the completed-title diagnostic](/blog/completed-title-still-in-progress/) rather than replaying the entire title. A checkpoint narrows the problem to a reproducible event pair.

Norva can retain progress across supported devices under the same account, but exact completion and episode-transition rules require verification in the current build.

## Use checkpoints during series rollover

Create one card per tested episode boundary. Do not assume that series-level, season-level, and episode-level cards communicate the same state. [Audit episode rollover](/blog/audit-series-episode-rollover/) with a small representative sample and preserve the expected-versus-observed mapping.

If the result requires escalation, attach the checkpoint fields to [the resume-row support report](/blog/document-resume-row-issue/). A concise table is more actionable than a long description without identity or timing.

## Original evidence: checkpoint card

The three-stage card is the original evidence. Test it on one harmless item and ask a second reviewer to identify the intended endpoint and first post-playback state. If either is ambiguous, revise the labels before using the method for a real issue.

The card improves the accuracy of human reporting. It does not modify progress, reveal internal processing, or guarantee how a product classifies completion.

## Common mistakes and limitations

- Defining completion only after seeing the result.
- Omitting version or episode identity.
- Recording a rounded time without an offset.
- Switching screens before capturing the first After state.
- Repeating playback until the original event is obscured.
- Treating the checkpoint as a universal completion threshold.

The method depends on the media and source being available and authorised for the test.

## Frequently asked questions

### Is the endpoint always the final frame?

No. Define the viewer’s intended completion landmark and separately record what the interface displays.

### Do I need a screenshot?

Not always. A precise text card can be enough and may expose less private information.

### Can one checkpoint cover a whole season?

No. Use one checkpoint for a specific transition, then sample additional boundaries only when necessary.

## Your next step

[Get Help From Norva Support](https://norva.tv/support)

## Sources

- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
