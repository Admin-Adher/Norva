---
content_id: "NVB-284"
title: "How to Investigate the Wrong Episode in a Resume Row"
seo_title: "Investigate the Wrong Episode in a Resume Row"
meta_description: "Trace a wrong episode in Continue Watching with a season-and-episode identity check, event timeline, profile comparison, controlled playback, and support record."
slug: "wrong-episode-in-resume-row"
canonical_url: "https://norva.tv/blog/wrong-episode-in-resume-row/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should viewers investigate the wrong episode in a resume row?"
supporting_questions:
  - "How can episode identity be verified?"
  - "When should an episode rollover issue be escalated?"
audience:
  - "Series viewers seeing an unexpected resume episode"
  - "Norva users documenting playback progression"
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
excerpt: "A season-aware diagnostic that separates card labelling, episode rollover, profile context, and version identity before a support report."
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
  - "/blog/audit-series-episode-rollover/"
  - "/blog/use-completion-checkpoints/"
  - "/blog/document-resume-row-issue/"
cta:
  label: "Send a Clear Support Request"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.rfc-editor.org/rfc/rfc3339"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "episode transition timeline"
  summary: "A six-event timeline records the episode opened, endpoint reached, exit action, next card shown, profile, and timestamp."
  methodology: "Readers reproduce one transition on a confirmed profile and version, keeping a timestamped before-and-after record while avoiding unrelated viewing data."
  asset_urls: []
---

# How to Investigate the Wrong Episode in a Resume Row

> **In short:** Confirm whether the card is actually wrong before changing it. Record the expected season and episode, the episode last played, its endpoint, the active profile, and any version clues. Reproduce one transition without switching context, then compare the next resume card. Escalate with a short timeline if the exact series path remains inconsistent.

A resume card can look wrong for several reasons: its label may describe the series rather than the last episode, the previous episode may not have reached the intended checkpoint, another profile may be active, or a different series version may be involved. Investigation starts with identity.

## Define expected and observed episodes

Write two complete statements:

- **Expected:** “After finishing season 2, episode 3, I expected the next action to reference season 2, episode 4.”
- **Observed:** “The row referenced season 1, episode 6,” or “the card opened episode 3 again.”

Do not write only “wrong episode.” A label, opening destination, and saved progress point are three different observations. Record each separately.

DCMI metadata terms distinguish a resource from its relation to another resource. That distinction is helpful for series: the series, season, episode, and version are related entities, not interchangeable labels.

## Build a minimal transition timeline

Use a table with these fields:

| Event | What to record |
|---|---|
| Open | Series, season, episode, version clues |
| Playback | Starting marker and active profile |
| Endpoint | Where viewing intentionally stopped |
| Exit | Normal control used |
| Reopen | Resume-card label and destination |
| Compare | Expected versus observed result |

Add local timestamps with offsets so two screens can be compared unambiguously. RFC 3339 is a useful format. Keep the record private and exclude credentials or unrelated history.

## Verify the context that can shift

Before reproducing anything, confirm the visible profile, source context, and exact series version. Check whether episode numbering differs between versions or whether specials are represented separately. Do not force an external episode order onto the connected source; record what the source and current interface actually present.

If the issue follows a profile change, apply [the post-switch resume-row review](/blog/review-row-after-profile-switch/). If it follows a version change, use [the safe version-change resume workflow](/blog/resume-after-version-change/) first.

## Reproduce one episode boundary

Choose a non-sensitive episode you are authorised to access. On one device and confirmed profile:

1. capture the current card;
2. open the exact expected episode;
3. verify the title and episode label inside the detail or playback context;
4. play to a deliberate endpoint allowed by your test;
5. exit normally;
6. reopen the resume row once;
7. record both the displayed label and opened destination.

Do not repeat several transitions in quick succession. One clean event sequence is more useful than many overlapping writes.

For broader series testing, [audit episode rollover with a controlled sample](/blog/audit-series-episode-rollover/) rather than changing multiple seasons at once.

## Interpret the result cautiously

If the label differs but the card opens the expected episode, the issue may concern presentation rather than destination. If both label and destination are wrong, compare profile and version again. If only another screen differs, run a cross-screen comparison with matching context and timestamps.

Norva can keep progress across supported devices under the same account, but exact rollover rules and synchronization timing require current product verification. Do not promise a specific automatic next-episode behavior in a draft.

When the controlled sequence still produces the wrong destination, use [the resume-row support template](/blog/document-resume-row-issue/). Include expected and observed statements, six-event timeline, device category, app or browser version if visible, and cropped evidence.

## Original evidence: episode transition timeline

The six-event table is the evidence asset. Have a second reviewer read it without additional explanation. If they can identify the episode opened, endpoint, profile, next card, and mismatch, the record is support-ready. If they cannot, add the missing identity field rather than more narrative.

This method demonstrates the sequence a viewer observed. It does not prove why an internal system chose that state.

## Common mistakes and limitations

- Confusing a series-level label with the episode destination.
- Omitting season numbers when titles repeat.
- Testing on a different version from the original session.
- Switching profiles midway through reproduction.
- Assuming a particular episode order is universal.
- Sharing a screenshot that exposes household history.

Episode structure and availability depend on the compatible source and media. Investigation cannot correct source metadata.

## Frequently asked questions

### What if the card has no episode number?

Open the detail safely and record the destination it presents. Treat label and destination as separate evidence.

### Should I finish another episode to confirm the issue?

One controlled transition is normally a better first test. Preserve the result before adding events.

### Can a special episode affect numbering?

It can change the sequence presented by a source. Record the actual labels and relations rather than assuming a standard order.

## Your next step

[Send a Clear Support Request](https://norva.tv/support)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [Norva Support](https://norva.tv/support)
