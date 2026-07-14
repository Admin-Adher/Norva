---
content_id: "NVB-265"
title: "What to Do With Favorites That Become Unavailable"
seo_title: "What to Do With Unavailable Media Favorites"
meta_description: "Handle unavailable favorites with an identity-preservation tree separating source status, authorization, version, preference, retrieval purpose, and review timing."
slug: "handle-unavailable-favorites"
canonical_url: "https://norva.tv/blog/handle-unavailable-favorites/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "decision-guide"
topic_cluster: "Favorites & Watchlists"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "What should someone do when a favorite becomes unavailable?"
supporting_questions:
  - "How can temporary source status be separated from title identity?"
  - "When should an unavailable item be kept, replaced, or removed?"
audience:
  - "Viewers whose saved titles are no longer playable"
  - "Norva users reviewing changed source availability"
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
excerpt: "An identity-preservation tree keeps a source outage or missing version from automatically erasing a durable preference."
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
parent_pillar: "/blog/favorites-curation-guide/"
related_articles:
  - "/blog/recover-missing-favorite/"
  - "/blog/favorite-correct-media-version/"
  - "/blog/review-favorites-after-watching/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "unavailable-favorite identity-preservation tree"
  summary: "The tree tests favorite existence, item identity, source status, authorization, alternate authorized versions, ongoing intent, and next review before keep, relink, move, or remove."
  methodology: "Readers capture the saved identity, test filters and scope, verify source availability separately, compare variants, and alter the favorite only after its future purpose is decided."
  asset_urls: []
---

# What to Do With Favorites That Become Unavailable

> **In short:** Preserve the favorite’s exact identity before changing it. Check whether the card is hidden, the source changed, authorization expired, or only one version became unavailable. Then decide whether the future purpose still matters. Keep the reference, link a verified authorized version, move it to a review list, or remove it—without erasing history or progress.

Availability is a current source condition; favorite status is a preference and retrieval decision. Treating them as the same can delete valuable intent during a temporary outage or leave an unusable duplicate after a version change.

## Use the identity-preservation tree

| Check | Evidence | Next action |
|---|---|---|
| Is the favorite still present? | Filters, scope, device comparison | Recover or continue |
| Is the work identity unchanged? | Title, type, identifiers, relations | Match or investigate |
| Is the exact version unavailable? | Source/version status | Compare alternatives |
| Is the source authorized and current? | Safe account/source state | Restore or stop |
| Does the future intent remain? | Original admission reason | Keep, move, or remove |
| When should it be reviewed? | Trigger/date | Schedule next check |

Do not paste private source credentials into the tree.

## Confirm that it is truly unavailable

Clear active filters, verify viewer or profile scope, and check another supported device if sync matters. If the favorite itself appears missing, use [the missing-favorite investigation](/blog/recover-missing-favorite/) before adding a replacement.

Then separate two observations:

- favorite record visible or not visible;
- media version currently available or unavailable.

They can differ.

## Preserve exact identity

Record work title, media type, release context, series hierarchy, stable identifiers, and version attributes. DCMI metadata terms distinguish identifier, relation, format, language, and availability-related concepts. That makes it possible to retain the work preference while investigating a specific version.

## Check source and authorization safely

Norva does not provide a supplied media catalogue. Users connect compatible sources they own or are authorized to access. Verify that the intended source remains connected and authorized, without sharing passwords, tokens, or private URLs.

An unavailable source does not prove that the work no longer exists. It establishes only the current access condition.

## Compare authorized versions

If another authorized version is available, use [the correct-version favorite workflow](/blog/favorite-correct-media-version/). Compare work identity, edit, language, subtitles, runtime, and source. Do not transfer the favorite blindly to a similarly titled card.

Keep the old identity in the decision record until the replacement is verified.

## Choose one of four outcomes

### Keep the favorite

Use this when long-term preference or reference value remains and current unavailability is acceptable. Add a review date, not an assumed return date.

### Relink to a verified version

Use this when the future action can be fulfilled by another authorized version and its identity differences are understood.

### Move to an investigation list

Use this when work or version identity, source state, or synchronization remains unclear. Avoid leaving an active next-up promise that cannot currently be fulfilled.

### Remove

Use this when the future purpose has ended and removal scope is understood. Confirm that history and progress are separate.

## Communicate current state

W3C notification guidance supports precise messages: “Saved title retained; selected version currently unavailable from the connected source; review scheduled.” Avoid claiming a return date that the source has not supplied.

## Reassess after watching or intent changes

If the favorite was retained for rewatch but the viewer no longer wants it, apply [the post-watch review](/blog/review-favorites-after-watching/). Preference can end independently of availability.

## Common mistakes and limitations

- Removing the favorite before recording identity.
- Confusing hidden filters with unavailability.
- Treating source status as work deletion.
- Relinking by title or artwork alone.
- Sharing secrets during troubleshooting.
- Promising when an item will return.

## Frequently asked questions

### Should unavailable favorites always be removed?

No. Keep or move them when the future action remains useful; remove only after an intent decision.

### Can another version replace the favorite?

Yes, after its work and version identity, required tracks, and authorization are verified.

### What if availability differs by device?

Compare account, source, version, and device state. Do not change the favorite until the layer is known.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
