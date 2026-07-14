---
content_id: "NVB-285"
title: "How to Handle Multiple Versions in Continue Watching"
seo_title: "Handle Multiple Versions in Continue Watching"
meta_description: "Compare multiple Continue Watching versions by work identity, edition, source context, language, format, progress, and viewer intent before keeping or clearing either card."
slug: "duplicate-versions-in-resume-row"
canonical_url: "https://norva.tv/blog/duplicate-versions-in-resume-row/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to guide"
topic_cluster: "Continue Watching Hygiene"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should viewers handle multiple versions in Continue Watching?"
supporting_questions:
  - "How can two versions of one work be distinguished?"
  - "Which version should remain active?"
audience:
  - "Viewers seeing duplicate-looking resume cards"
  - "Norva users managing grouped variants"
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
excerpt: "A work-and-version comparison that prevents duplicate-looking cards from being merged or removed before their differences are understood."
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
  - "/blog/resume-after-version-change/"
  - "/blog/clear-sampled-titles-from-resume-list/"
  - "/blog/continue-watching-hygiene-checklist/"
cta:
  label: "See Norva's Organisation Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.w3.org/TR/media-accessibility-reqs/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "work-and-version comparison sheet"
  summary: "A side-by-side sheet separates shared work identity from edition, source, language, subtitle, format, duration, progress, and viewer intention."
  methodology: "Readers inspect both cards without playback, fill only visible or verified fields, then open one at a time to confirm distinguishing attributes before deciding which state to retain."
  asset_urls: []
---

# How to Handle Multiple Versions in Continue Watching

> **In short:** Treat duplicate-looking cards as separate until proven otherwise. Compare the shared work identity with version-specific fields such as edition, source context, language, subtitles, format, duration, episode mapping, and progress. Keep the version you intend to resume, preserve any unresolved state, and test one change before clearing another card.

Two cards with the same poster can represent one accidental duplicate, two legitimate versions, or two viewers’ activity. The safest approach separates the creative work from the particular media version before making a cleanup decision.

## Create a work-and-version comparison

Place the cards in columns A and B:

| Field | Version A | Version B |
|---|---|---|
| Work title and date |  |  |
| Series, season, episode |  |  |
| Edition or cut |  |  |
| Source context |  |  |
| Audio language |  |  |
| Subtitle availability |  |  |
| Format or quality label |  |  |
| Duration |  |  |
| Displayed progress |  |  |
| Active viewer or profile |  |  |
| Intention to resume |  |  |

Use “unknown” rather than guessing. DCMI metadata terms provide a useful model: title, identifier, format, language, and relation describe different aspects of an item.

## Inspect before playing

Start with card and detail information so playback does not create a fresh progress event. Compare title suffixes, dates, episode labels, durations, audio and subtitle labels, and source names when available. Languages and subtitles depend on the source and media, so absence on one version does not prove the other is identical.

W3C’s media accessibility requirements explain why captions, subtitles, descriptions, and alternative language tracks are meaningful media characteristics rather than cosmetic labels. Preserve the version that meets the viewer’s actual access needs.

## Confirm one version at a time

If visible metadata is insufficient, open version A on the confirmed profile and record the identifying details. Exit without advancing more than necessary. Reopen the row, then repeat for B only after the first observation is stable.

Do not alternate rapidly between versions. That can create two fresh progress states and make the original question harder to answer. If a title version changed during an active watch, follow [the safe version-change workflow](/blog/resume-after-version-change/) to establish a deliberate new checkpoint.

## Decide based on future intent

There are four common outcomes:

- **Keep A:** it is the version you intend to finish; B was a confirmed sample.
- **Keep B:** it better matches the needed episode mapping, language, subtitles, or edition.
- **Keep both:** different viewers or legitimate future uses require separate states.
- **Investigate:** identity, profile scope, or progress ownership remains unknown.

Do not choose only by displayed quality. Norva organises compatible authorised sources and can group variants, according to its public features, but the exact relationship between grouping and resume state must be verified in the current product.

If one card was only sampled, apply [the sampled-title triage](/blog/clear-sampled-titles-from-resume-list/). Remove or dismiss a card only through a control whose current effect you understand.

## Verify a single cleanup action

Before a broader change, capture both cards. Change the clearly unwanted, non-sensitive entry. Reopen Continue Watching and confirm the intended card changed while the selected version, other profile state, history, and favorites were not assumed to change with it.

Use [the full hygiene checklist](/blog/continue-watching-hygiene-checklist/) when several duplicate-looking pairs appear after a source or device change.

## Original evidence: the comparison sheet

Fill the eleven-row sheet for one pair using only visible or verified information. Highlight the smallest set of fields that distinguishes A from B. Then write a one-sentence decision: “Keep B because it is the version with the required subtitles and the active progress checkpoint; classify A as an unresolved sample.”

The sheet makes the decision reproducible. It does not prove that two internal records should be merged, and it should not be used to claim a product defect.

## Common mistakes and limitations

- Assuming matching artwork means identical media.
- Starting both versions before recording the baseline.
- Ignoring episode and duration differences.
- Treating language or subtitles as minor when they affect access.
- Removing another viewer’s active version.
- Expecting grouping to combine every version-specific progress state.

When metadata is incomplete, preserve uncertainty and contact support with a cropped comparison rather than deleting both cards.

## Frequently asked questions

### Why can two versions show different progress?

They may represent distinct media entities, profiles, or sessions. Compare identity and context before drawing a conclusion.

### Should I always keep the highest-quality label?

No. Choose the version that matches availability, access needs, device context, and your authorised source—not one label alone.

### Can I combine the progress myself?

Do not assume that capability. Use only verified controls in the current product and preserve the original checkpoints until the outcome is clear.

## Your next step

[See Norva's Organisation Features](https://norva.tv/#features)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [W3C: Media Accessibility User Requirements](https://www.w3.org/TR/media-accessibility-reqs/)
- [Norva Features](https://norva.tv/#features)
