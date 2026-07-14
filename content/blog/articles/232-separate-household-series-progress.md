---
content_id: "NVB-232"
title: "How to Keep Household Series Progress Separate"
seo_title: "Keep Household Series Progress Separate"
meta_description: "Keep each viewer's series progress distinct with a viewer-state matrix, explicit shared-session updates, and a safe fallback when profile scope is unclear."
slug: "separate-household-series-progress"
canonical_url: "https://norva.tv/blog/separate-household-series-progress/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How can household members keep series progress separate?"
supporting_questions:
  - "How should shared viewing sessions be recorded?"
  - "What should a household do when profile scope is unclear?"
audience:
  - "Households where several people watch the same series"
  - "Norva users evaluating cross-device progress workflows"
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
excerpt: "A viewer-state matrix prevents one household member's playback from silently advancing another person's next episode."
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
parent_pillar: "/blog/series-library-workflow-guide/"
related_articles:
  - "/blog/manage-weekly-series-progress/"
  - "/blog/fix-wrong-episode-resume-context/"
  - "/blog/verify-next-episode/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "consideration"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.w3.org/WAI/tutorials/forms/labels/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "household viewer-state matrix"
  summary: "A matrix records series, episode, position, completion, last action, and confidence independently for each viewer."
  methodology: "Readers establish the actual scope of stored progress, test it with a harmless episode, then update only named viewers after solo or shared sessions."
  asset_urls: []
---

# How to Keep Household Series Progress Separate

> **In short:** Give every viewer a distinct state for the exact series and episode. First test whether progress is scoped to an account, profile, device, or source. Update only the people who watched, and keep a small external ledger when the product’s scope cannot be confirmed. Never infer that a household feature exists from the appearance of an avatar or device name.

When several people follow the same show, a single progress bar becomes ambiguous. It might mean one person finished the episode, the whole household watched together, or playback simply reached the end on a shared device. The remedy is explicit identity and scope, not more guessing.

## Create a viewer-state matrix

Use one row per viewer and series:

| Viewer label | Series identity | Last verified episode | Position | State | Last action | Confidence |
|---|---|---|---|---|---|---|
|  |  |  |  | Not started / in progress / complete | Solo / shared / correction | High / medium / low |

The viewer label can be a product profile only when that scope is confirmed. Otherwise, use a household nickname in a private external note. Avoid collecting unnecessary personal data; the matrix needs identity within the household, not a biography.

## Determine where progress is stored

Before changing anything important, run a reversible test with a non-critical episode:

1. note the current episode and position on device A;
2. play briefly under the intended account or profile;
3. stop at a recognizable point;
4. check the same context on device B;
5. switch viewer context, if one is clearly available, and compare;
6. restore the original state if the interface permits it.

Classify the observed scope as account-wide, profile-specific, device-local, source-specific, or still unknown. Do not assume a particular Norva profile or household behavior without current product verification. Norva states that the same account may retain catalogue, progress, history, favorites, and preferences across supported devices; the exact viewer separation available in a given build should be checked in current support material.

## Label every playback action

W3C form guidance explains why visible labels matter: a control needs an understandable purpose. The same rule helps household state. Replace “watched” with “Alex completed S1E3 together with Sam” or “Household A stopped S1E4 at 18:20.” A named action makes later correction possible.

After a solo session, update only that viewer. After shared viewing, update every person who actually participated. If someone left early, give that viewer an in-progress position rather than the group’s completion state.

## Keep source state separate from viewer state

Episode availability, series hierarchy, and language tracks belong to the connected source or item version. Completion and resume position belong to the viewing context. Do not make one stand in for the other.

If an item disappears or its metadata changes, preserve the viewer matrix and follow [the wrong-resume diagnostic](/blog/fix-wrong-episode-resume-context/) before moving any position. A source refresh should not silently advance a person to a neighboring episode.

## Handle weekly and irregular releases

For a current show, connect each viewer row to [the weekly progress ledger](/blog/manage-weekly-series-progress/). One person may be current, another two episodes behind, while the next release remains unconfirmed for everyone. “Household is up to date” hides all three facts.

When starting again, run [the next-episode preflight](/blog/verify-next-episode/) for the selected viewer. Confirm series, season, episode, version, and language before playback.

## Use a fallback when scope is uncertain

If you cannot prove that the interface separates viewers, do not experiment on valuable progress. Maintain a compact private ledger outside the app:

- viewer label;
- last completed episode;
- current in-progress position;
- date checked;
- device or context;
- unresolved mismatch.

Treat the app’s displayed state as one observation, not the household’s universal truth. Once scope is verified, reconcile the ledger carefully instead of bulk-marking items.

## Recovery protocol for crossed progress

1. Stop playback before more state is written.
2. Identify the exact viewer, episode, and version involved.
3. Capture the displayed position and completion state.
4. Compare with the last high-confidence matrix row.
5. Correct only the affected viewer context.
6. Recheck the next episode on every shared device.

## Common mistakes and limitations

- Treating one device as one viewer.
- Assuming an avatar guarantees isolated progress.
- Updating everyone after only some people watched.
- Using availability as evidence of completion.
- Keeping no record of manual corrections.
- Storing more personal information than the workflow needs.

## Frequently asked questions

### Can device names replace viewer names?

No. Several people may use one device, and one person may use several devices.

### What if two people intentionally share progress?

Create a clearly named shared row and keep individual rows only if they also watch separately.

### Should the matrix include every episode?

Usually not. Record the last confirmed completion and any active in-progress item, then preserve exceptions separately.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [W3C: Labeling Controls](https://www.w3.org/WAI/tutorials/forms/labels/)
- [Norva Support](https://norva.tv/support)
