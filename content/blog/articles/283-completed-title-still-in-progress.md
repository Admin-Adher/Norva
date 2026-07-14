---
content_id: "NVB-283"
title: "Why a Completed Title May Still Look In Progress"
seo_title: "Why a Completed Title Still Looks In Progress"
meta_description: "Diagnose a completed title that remains in progress by checking its ending point, exact version, profile, cross-screen state, and a controlled replay result."
slug: "completed-title-still-in-progress"
canonical_url: "https://norva.tv/blog/completed-title-still-in-progress/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Why can a completed title still appear in progress?"
supporting_questions:
  - "Which context checks distinguish completion from stale progress?"
  - "What evidence should be gathered before contacting support?"
audience:
  - "Viewers seeing a completed title in Continue Watching"
  - "Norva users troubleshooting progress state"
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
excerpt: "A controlled diagnostic for separating an unfinished ending, version mismatch, profile mismatch, or cross-screen state from a genuine progress problem."
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
  - "/blog/use-completion-checkpoints/"
  - "/blog/resume-row-differs-between-screens/"
  - "/blog/document-resume-row-issue/"
cta:
  label: "Open Norva Support"
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
  type: "completion-state diagnostic worksheet"
  summary: "A before-and-after worksheet records exact identity, displayed progress, ending point, profile, device, and post-replay state."
  methodology: "Capture a baseline, replay a short non-sensitive segment near the intended ending on one profile and device, close normally, then compare the same fields without claiming a universal completion threshold."
  asset_urls: []
---

# Why a Completed Title May Still Look In Progress

> **In short:** “Finished watching” and “recorded as complete” are not always the same observation. First confirm the exact version, profile, displayed ending point, and screen. Then run one controlled replay near the intended ending and compare the row afterward. If the state remains wrong, document the result rather than repeatedly playing or clearing the item.

A completion mismatch is frustrating because the viewer’s memory feels certain while the interface shows something else. The fastest diagnosis separates what was watched from the identity and state the application actually displays.

## Possible explanations to test

Treat these as hypotheses, ordered by how easy they are to verify:

1. **The playback ended before the application recorded the intended endpoint.** Credits, an interruption, or an early close may leave a visible remainder.
2. **A different version was completed.** Two editions can share a title and artwork while retaining separate progress.
3. **A different profile recorded the session.** The visible row may belong to another viewer context.
4. **Another screen shows a different state.** A supported device may not yet display the same observation.
5. **An episode boundary is involved.** A completed episode and a series-level resume card can describe different things.

None of these possibilities should be assumed without evidence. Norva’s current completion rules and UI controls need verification in the current build.

## Capture a baseline before replaying

Record the local date and time using a clear offset, device category, visible profile, exact title, season and episode if applicable, version clues, displayed progress, and the point where you believe viewing ended. RFC 3339 provides an unambiguous timestamp format, which helps when comparing events across screens.

Do not include account credentials, source secrets, or a screenshot exposing unrelated household history. A cropped image or text record is enough.

Use [completion checkpoints](/blog/use-completion-checkpoints/) when you want a repeatable way to distinguish the viewer’s endpoint from the displayed marker.

## Run one controlled ending check

Choose the exact entry from the baseline. On the confirmed profile and one device:

1. open the same title or episode;
2. verify version, language, and other visible identity clues;
3. move to a short point near the ending you intended to complete;
4. let playback reach that endpoint without switching profiles;
5. exit using the normal available control;
6. reopen Continue Watching once;
7. record the new displayed state and time.

This is a diagnostic, not a claim that every product uses the same completion threshold. Avoid repeating the process many times because repeated writes make the event sequence harder to interpret.

## Compare identity before blaming progress

DCMI metadata terms distinguish identifier, relation, format, and language. Apply that logic to the two observations: was the replay the same work, same episode, and same version as the original session? If not, two progress records may be legitimate.

If cards differ between devices, use [the cross-screen comparison workflow](/blog/resume-row-differs-between-screens/) and hold profile, version, and time constant. Do not clear either state while the comparison is unresolved.

## Decide the next action

If the row now reflects completion, note the successful path and stop testing. If a different version remains active, classify it separately. If the exact same entry remains in progress, preserve the baseline and controlled result for support.

Follow [the support evidence template](/blog/document-resume-row-issue/) to report expected versus observed behavior. State what you can prove: “After replaying this exact episode to the intended ending on profile A, the row still showed the recorded marker at 20:14 local time.” Avoid diagnosing the backend or claiming data loss.

## Original evidence: completion-state worksheet

Create two columns labelled Before and After. Use rows for timestamp, device, profile, work, episode, version, displayed marker, intended ending, action, and result. Add a confidence field for each identity attribute.

The worksheet produces a reproducible event pair. It cannot reveal an internal cause, but it helps a reviewer rule out wrong-profile and wrong-version explanations before escalation.

## Common mistakes and limitations

- Assuming credits always define completion in the same way.
- Replaying a different edition because the artwork matches.
- Switching devices or profiles during the test.
- Clearing the entry before preserving the baseline.
- Taking a full-screen photo that exposes private history.
- Treating one delayed observation as proof of permanent failure.

Source availability and media structure can affect what can be replayed. Only test media from a compatible source you are authorised to use.

## Frequently asked questions

### Does reaching the credits always mark a title complete?

Do not assume a universal rule. Record the actual endpoint and verify the current product behavior.

### Should I replay the whole title?

Usually not for diagnosis. A short controlled ending check is easier to compare, provided your access and media structure allow it.

### What if the title disappears from one screen but not another?

Capture both states with timestamps, then compare the same profile and version before taking further action.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
