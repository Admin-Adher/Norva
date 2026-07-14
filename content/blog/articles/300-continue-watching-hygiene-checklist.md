---
content_id: "NVB-300"
title: "A Continue Watching Hygiene Checklist"
seo_title: "Complete Continue Watching Hygiene Checklist"
meta_description: "Audit Continue Watching for identity, profile, intent, progress, versions, episode transitions, cross-screen state, privacy, safe actions, and review ownership."
slug: "continue-watching-hygiene-checklist"
canonical_url: "https://norva.tv/blog/continue-watching-hygiene-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "checklist"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Which checklist keeps Continue Watching accurate, useful, and safe to maintain?"
supporting_questions:
  - "Which checks block a bulk cleanup?"
  - "How should profile, version, and cross-screen uncertainty be handled?"
audience:
  - "Viewers auditing Continue Watching quality"
  - "Norva users preparing a larger resume-row review"
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
excerpt: "A release-style checklist that blocks destructive cleanup until item identity, viewer scope, progress, version, intent, and recovery are proven."
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
  - "/blog/continue-watching-hygiene-guide/"
  - "/blog/weekly-resume-row-review/"
  - "/blog/document-resume-row-issue/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html"
  - "https://www.rfc-editor.org/rfc/rfc3339"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "Continue Watching release-gate checklist"
  summary: "A twelve-gate checklist covers context, identity, ownership, intent, checkpoint, completion, versions, episodes, screens, offline events, privacy, and safe change verification."
  methodology: "Reviewers mark each gate pass, fail, or unknown with concise evidence; any unknown in identity, ownership, or action scope blocks bulk cleanup and triggers a targeted workflow."
  asset_urls: []
---

# A Continue Watching Hygiene Checklist

> **In short:** Before changing Continue Watching, confirm the account and profile, exact media identity, viewer ownership, future intent, progress checkpoint, version, episode mapping, cross-screen context, and offline events. Test one non-sensitive action and verify its scope. Any unknown in identity, ownership, or destructive effect blocks bulk cleanup.

This checklist is a release gate for resume-row maintenance. It turns a visual impression—“the row looks messy”—into explicit checks that protect useful progress and other viewers’ state.

## Set up the audit sheet

| Gate | Pass / fail / unknown | Evidence | Next action |
|---|---|---|---|
| Context |  |  |  |
| Item identity |  |  |  |
| Viewer ownership |  |  |  |
| Future intent |  |  |  |
| Progress checkpoint |  |  |  |
| Completion |  |  |  |
| Version |  |  |  |
| Episode rollover |  |  |  |
| Cross-screen state |  |  |  |
| Offline timeline |  |  |  |
| Privacy |  |  |  |
| Safe action |  |  |  |

Date the review, identify one profile and screen context, and capture a baseline. Use [the complete hygiene guide](/blog/continue-watching-hygiene-guide/) when a gate needs a full explanation.

## Gates 1–4: know what the entry means

- [ ] Account, profile, device, connectivity, and timestamp are recorded.
- [ ] Title, media type, series, season, episode, and version are distinguishable.
- [ ] The viewer or shared group that owns the state is known.
- [ ] Intent is active, deliberate pause, completed, sampled, abandoned, or unresolved.
- [ ] Unknown ownership is not treated as permission to remove.

DCMI metadata terms distinguish identifier, type, relation, format, and language. Use only the fields needed to prevent two similar cards from being confused.

## Gates 5–8: validate progress logic

- [ ] Displayed progress is recorded separately from remembered intent.
- [ ] A completion claim names an intended endpoint.
- [ ] Duplicate-looking versions have been compared side by side.
- [ ] Series-level labels are separate from episode destinations.
- [ ] One episode transition is tested before any broad conclusion.
- [ ] A version change preserves the old checkpoint until the new one is proven.

Do not invent a universal completion percentage or episode rule. Source structure and media versions can differ. Use the [completion-checkpoint card](/blog/use-completion-checkpoints/) for a controlled before-and-after record.

## Gates 9–10: control screen and connectivity variables

- [ ] Cross-screen comparisons use the same account, profile, item version, and observation window.
- [ ] Row position is not the only comparison field.
- [ ] Offline playback has a timestamped offline-to-connected timeline.
- [ ] No parallel playback created competing events during diagnosis.
- [ ] The first refreshed observation is preserved before repeated actions.

RFC 3339 timestamps with offsets make event order clearer. Norva can retain progress across supported devices under one account, but exact synchronization and conflict behavior requires current-product verification.

## Gate 11: protect privacy

- [ ] Notes exclude passwords, authentication codes, payment data, and source credentials.
- [ ] Screenshots are cropped to the relevant card.
- [ ] Unrelated household history is hidden.
- [ ] Profile names are minimised where a neutral label works.
- [ ] Evidence is shared only through the verified support route when escalation is needed.

The audit needs enough context to reproduce a problem, not a complete record of the household’s viewing.

## Gate 12: prove one safe action

- [ ] The current control’s label and intended effect are understood.
- [ ] A non-sensitive, confirmed candidate is selected.
- [ ] The action is performed once.
- [ ] The row is reopened and compared with the baseline.
- [ ] Other profiles, versions, history, and favorites are not assumed to share the effect.
- [ ] An unexpected result stops the cleanup.

W3C name, role, and value guidance supports controls whose identity and state are programmatically understandable. For viewers, a clear current label is still essential. When the effect remains unclear, leave the state intact and [document the issue for support](/blog/document-resume-row-issue/).

## Decide whether the row passes

Identity, ownership, and action scope are critical gates. A Fail or Unknown blocks bulk changes. Other failures create targeted work: compare versions, run a completion checkpoint, review profiles, or build an offline timeline.

Use [the weekly review routine](/blog/weekly-resume-row-review/) after the full audit establishes a safe baseline. Weekly maintenance should not repeat every gate unless the context changes.

## Original evidence: release-gate checklist

Apply all twelve gates to one screenful and record the evidence behind each status. Ask a second reviewer to challenge every Pass based only on the sheet. Downgrade unsupported passes to Unknown.

The resulting audit is reproducible and conservative. It measures the quality of the maintenance decision, not Norva performance or universal reliability.

## Common mistakes and limitations

- Passing a gate because the poster looks familiar.
- Combining viewer intent with displayed progress.
- Treating Unknown as harmless during bulk cleanup.
- Testing multiple actions without baselines.
- Exposing private history in evidence.
- Claiming source metadata can be repaired through row hygiene.

Available media, languages, subtitles, and offline access remain conditional on source, device, media, and rights.

## Frequently asked questions

### Must every gate pass for a one-item review?

Only relevant gates need evidence, but identity, ownership, and action scope remain mandatory before a change.

### How often should the full checklist run?

Use it after material profile, source, device, or interface changes and before a large cleanup. Use the shorter weekly routine otherwise.

### Can the checklist automate decisions?

No. It structures human verification; uncertain viewer intent and ambiguous versions still require judgement.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [W3C: Understanding Name, Role, Value](https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html)
- [RFC 3339: Date and Time on the Internet](https://www.rfc-editor.org/rfc/rfc3339)
- [Norva Support](https://norva.tv/support)
