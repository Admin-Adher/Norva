---
content_id: "NVB-288"
title: "Why Continue Watching Can Differ Between Screens"
seo_title: "Why Continue Watching Differs Between Screens"
meta_description: "Compare Continue Watching across screens by controlling profile, account, title version, connectivity, timestamp, and refresh order before diagnosing a persistent mismatch."
slug: "resume-row-differs-between-screens"
canonical_url: "https://norva.tv/blog/resume-row-differs-between-screens/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Why can Continue Watching differ between supported screens?"
supporting_questions:
  - "Which variables must match in a cross-screen comparison?"
  - "How can a persistent mismatch be documented?"
audience:
  - "Viewers moving between supported screens"
  - "Norva users troubleshooting synchronized progress"
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
  source_of_truth: "https://norva.tv/#features"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 7
excerpt: "A controlled two-screen comparison that distinguishes account, profile, version, timing, connectivity, and presentation differences."
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
  - "/blog/offline-progress-returns-later/"
  - "/blog/review-row-after-profile-switch/"
  - "/blog/document-resume-row-issue/"
cta:
  label: "See Norva Across Your Devices"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc3339"
  - "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "controlled two-screen comparison matrix"
  summary: "A paired matrix holds account, profile, item version, connectivity, timestamp, and refresh action constant while recording the row on two supported screens."
  methodology: "Readers capture both baselines, make one playback change on screen A, close normally, inspect A, then inspect B once without further playback and compare exact fields."
  asset_urls: []
---

# Why Continue Watching Can Differ Between Screens

> **In short:** Two screens are comparable only when they use the same account, confirmed profile, exact title version, connectivity condition, and observation window. Capture both baselines, make one controlled playback change on screen A, then inspect A and B once. A persistent difference with matched context is useful evidence; an uncontrolled snapshot is not.

Cross-screen continuity is valuable precisely because viewers expect one intention to survive a change of screen. When the rows differ, first rule out mismatched context before assuming progress failed to synchronise.

## Match six comparison variables

Build a two-column sheet for screen A and screen B:

| Variable | Screen A | Screen B |
|---|---|---|
| Signed-in account | Confirmed | Confirmed |
| Active profile |  |  |
| Exact work and version |  |  |
| Connectivity |  |  |
| Product version if visible |  |  |
| Observation timestamp |  |  |

If any field differs, note it as a confounder. W3C’s consistent-identification guidance reinforces the value of controls and components that retain understandable identification; your test should be equally explicit.

Norva says a single account can retain progress and preferences across supported devices. The statement does not establish a guaranteed refresh interval or describe every conflict case, so current behavior must be verified before publication.

## Capture paired baselines

Without playing anything, open Continue Watching on A and B. Record the exact card label, episode where relevant, displayed progress, position in the row, and timestamp with offset. RFC 3339 formatting makes the observation order unambiguous.

Position alone is weak evidence because sorting or presentation can differ. Identity and progress are stronger fields. If a profile was just changed, complete [the profile-switch review](/blog/review-row-after-profile-switch/) first.

Also record whether each screen was opened from a fresh launch, an existing session, or a return from playback. Use the same route where possible; different entry paths are another variable, not proof of a synchronization problem.

## Make one controlled change

Choose one non-sensitive item from a compatible source you are authorised to use. On screen A:

1. confirm the account, profile, and version;
2. start at the recorded point;
3. play to a deliberate new checkpoint;
4. exit normally;
5. reopen the row once and capture the result;
6. move to B without playing the item there;
7. perform one normal refresh or reopen action supported by the current interface;
8. capture B’s result and time.

Do not alternate playback between screens. If A was offline, follow [the offline reconnection timeline](/blog/offline-progress-returns-later/) instead of combining two tests.

## Classify the difference

**Presentation difference:** both screens point to the same item and progress but show different order or labels. **Context difference:** account, profile, version, or connectivity does not match. **Temporary observation difference:** the first snapshots differ but a later controlled observation aligns. **Persistent matched-context mismatch:** the same identity and profile remain inconsistent after the single comparison.

Only the last category is ready for escalation. Preserve screenshots cropped to the relevant card, timestamps, device categories, visible versions, and exact steps. Use [the support documentation guide](/blog/document-resume-row-issue/) to avoid speculation.

## Original evidence: two-screen matrix

The matrix and paired baseline constitute the original evidence. Ask a second person to identify the single changed variable and reconstruct the observation order. If they need assumptions, the test record is incomplete.

This framework measures consistency within one controlled session. It cannot establish performance guarantees, universal device compatibility, or the internal cause of a mismatch.

## Common mistakes and limitations

- Comparing different profiles with similar avatars.
- Opening different versions of the same work.
- Using row position as the only comparison.
- Playing on B before capturing its first observation.
- Mixing an offline test with a connected test.
- Repeatedly refreshing without timestamps.
- Exposing unrelated history in full-screen evidence.

Supported screens, browsers, and offline availability are conditional. Check current product and source requirements before testing.

## Frequently asked questions

### Must both screens show the same row order?

Do not assume that order alone defines consistency. Compare exact item identity and progress first.

### How long should I wait before comparing?

This guide does not invent a sync interval. Record the first controlled observations and use current support guidance for any required timing.

### What if only one title differs?

Compare that title’s version, profile, and event history. A narrow mismatch is easier to document than a whole-row claim.

## Your next step

[See Norva Across Your Devices](https://norva.tv/#features)

## Sources

- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [W3C: Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)
- [Norva Features](https://norva.tv/#features)
