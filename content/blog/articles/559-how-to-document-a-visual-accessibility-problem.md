---
content_id: "NVB-559"
title: "How to Document a Visual Accessibility Problem"
seo_title: "How to Document a Visual Accessibility Problem"
meta_description: "Create a reproducible visual-accessibility report with context, exact task, expected and observed results, settings, input path, impact, and privacy-safe evidence."
slug: "how-to-document-a-visual-accessibility-problem"
canonical_url: "https://norva.tv/blog/how-to-document-a-visual-accessibility-problem/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "reporting-workflow"
topic_cluster: "Visual Comfort & Accessibility"
search_intent: "report visual accessibility issue"
funnel_stage: "retention"
primary_question: "How should a visual accessibility problem be documented?"
supporting_questions:
  - "Which environment, settings, task, state, and evidence fields make a report reproducible?"
  - "How can reports protect account, household, source, and viewing privacy?"
audience:
  - "Viewers reporting visual barriers"
  - "Support and product teams reproducing issues"
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
estimated_reading_minutes: 7
excerpt: "A privacy-safe issue template for reproducing visual barriers across environment, device, settings, content state, input path, and task impact."
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
parent_pillar: "/blog/the-complete-guide-to-visual-comfort-in-media-interfaces/"
related_articles:
  - "/blog/a-visual-comfort-and-accessibility-checklist/"
  - "/blog/how-to-audit-a-viewing-environment-for-visual-barriers/"
  - "/blog/legibility-and-readability-two-different-viewing-problems/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/test-evaluate/preliminary/"
  - "https://www.w3.org/WAI/eval/report-tool/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "visual barrier reproduction card"
  summary: "A structured card separates viewer report, reviewer observation, environment, device, exact steps, expected and observed results, task impact, one-variable comparison, and sanitised evidence."
  methodology: "The reporter reproduces the shortest safe path twice, records exact context without diagnosis, removes private information from media, and preserves raw observations separately from inferred cause."
  asset_urls: []
---
# How to Document a Visual Accessibility Problem

> **In short:** Describe the exact task, device, platform version, page, content state, text or motion setting, lighting or distance when relevant, input sequence, expected result, and observed barrier. Reproduce the shortest safe path twice, record impact and workaround, and attach only privacy-safe evidence. Separate what the viewer said, what the reviewer observed, and what the team thinks may be causing it.

"The text is bad" communicates frustration but gives a product team little to reproduce. A strong report names the element and boundary: for example, a year and rating overlap after one supported text-size increase in a particular viewport.

## Start with the blocked task

Write what the viewer was trying to complete: choose a version, identify focus, read captions, close a dialog, or compare metadata. State impact in task terms rather than assigning severity from emotion alone.

[The legibility-versus-readability guide](/blog/legibility-and-readability-two-different-viewing-problems/) helps distinguish character recognition from hierarchy and comprehension.

## Capture the relevant context

Include device model when safely known, operating system, app or browser version, viewport or orientation, input method, language, page, content state, and supported accessibility preferences. For shared screens, add seat label, approximate distance and angle, ordinary lighting, and reflections only when relevant.

Use [the viewing-environment audit](/blog/how-to-audit-a-viewing-environment-for-visual-barriers/) to avoid unnecessary household details.

## Write exact reproduction steps

Start from a clear entry point and number every input. Name directional keys, Tab, Enter, Back, touch, or pointer actions. Include the state before the failure and the first step where expected and observed results diverge.

Retest the sequence once without changing settings. If it is intermittent, say so and record the observed frequency without inventing a percentage.

## Original evidence: reproduction card

| Field | Record |
|---|---|
| Viewer task and impact | Their goal and blocked outcome |
| Context | Device, version, viewport, language, setting, environment |
| Starting state | Page, focus, selection, content state |
| Exact inputs | Numbered path |
| Expected result | Observable outcome |
| Observed result | Observable difference |
| Workaround | What helped, if anything |
| Evidence | Sanitised screenshot/video/log reference |

Add separate lines for viewer wording, reviewer observation, and hypothesis.

## Make evidence privacy-safe

Remove names, email addresses, account identifiers, source addresses, payment details, viewing history, household faces, messages, and unrelated room content. Use a safe fixture or crop only when the crop still shows the failing context.

Do not post logs publicly without inspecting them. A text description may be enough when visual evidence would expose private data.

## Include one-variable comparisons carefully

If safe, repeat the task after changing one reversible variable: text setting, viewport, seat, light, background, or input. Restore the baseline afterward. Report the comparison as evidence, not as a demand that the viewer use the workaround.

Use [the visual-comfort checklist](/blog/a-visual-comfort-and-accessibility-checklist/) to identify which variable is relevant without running every test.

## Avoid diagnosing the cause too early

"Focus moves behind the panel after Down" is an observation. "The spatial algorithm is broken" is a hypothesis unless code or logs confirm it. Keep both, but label them differently.

Do not infer a medical condition from a viewer's difficulty or claim formal non-conformance without the applicable expert review.

## Make acceptance criteria observable

Describe the expected fix through the task: the full label remains available at the supported larger setting; focus is visible from the regular seat; closing the dialog returns focus to its opener. Avoid implementation instructions unless the report is for the team that owns the code.

## Submit through the right channel

Use the product's official support or accessibility channel, include a safe contact method if follow-up is welcome, and keep a copy of the report identifier. For Norva, current support routes and product behavior should be confirmed on the official site.

## Common mistakes and limitations

Avoid screenshots without steps, videos containing secrets, several settings changed together, guessed causes presented as facts, or reports that speak for a group without their input. A report supports investigation; it does not guarantee diagnosis or resolution time.

## Frequently asked questions

### Is a screenshot enough?

Usually not. Include task, starting state, exact steps, settings, expected result, and observed impact.

### Should private source details be included?

No. Remove credentials, addresses, identifiers, and unrelated history; share only the minimum safe context needed.

### Can a workaround close the report?

Not automatically. Record it, but assess whether the original supported task still contains a barrier.

## Your next step

[Contact Norva Support](https://norva.tv/support)

## Sources

- [W3C: Easy Checks](https://www.w3.org/WAI/test-evaluate/preliminary/)
- [W3C: WCAG-EM Report Tool](https://www.w3.org/WAI/eval/report-tool/)
- [Norva Support](https://norva.tv/support)
