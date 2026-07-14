---
content_id: "NVB-885"
title: "Category Order Keeps Resetting? Record the Trigger"
seo_title: "Category Order Keeps Resetting? Track the Trigger"
meta_description: "Troubleshoot category order changes by recording the before state, trigger, account, profile, source, filters, device, version, timing, and cross-screen result."
slug: "category-order-resets"
canonical_url: "https://norva.tv/blog/category-order-resets/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "category-order-troubleshooting"
topic_cluster: "Category & Metadata Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot category order changes?"
supporting_questions:
  - "Which before state, trigger, account, profile, source, filter, device, version, and timing evidence should be recorded?"
  - "How can a repeatable trigger be tested without assuming category order is saved?"
audience:
  - "Norva users seeing category order change"
  - "Household source administrators"
author: { name: "", profile_url: "" }
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
excerpt: "A category-order investigation captures the before sequence and the first event after which it differs, while holding account, profile, source, view, device, and version stable."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/category-metadata-troubleshooting-handbook/"
related_articles:
  - "/blog/category-metadata-troubleshooting-handbook/"
  - "/blog/duplicate-category-names/"
  - "/blog/category-hidden-on-one-device/"
  - "/blog/post-recovery-import-integrity-audit/"
cta:
  label: "Open Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/support"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "category order trigger timeline"
  summary: "A timeline records the category sequence before and after each candidate trigger, account and profile, source state, filters, device and application version, source order where visible, timestamps, and cross-screen comparison."
  methodology: "The user captures the initial sequence, changes one reversible variable or performs one ordinary event, records the first changed order, restores baseline where possible, and avoids repeated edits or unsupported persistence claims."
  asset_urls: []
---

# Category Order Keeps Resetting? Record the Trigger

> **In short:** Capture the full visible category sequence before it changes, plus account, profile, source selection, filters, sort, grouping, device, application version, and time. Then record the first event followed by a different sequence: navigation, sign-in, profile switch, application restart, device restart, source update, import, or refresh. Test one ordinary event at a time, compare another supported device, and never assume Norva saves a custom order unless current documentation confirms it.

“Keeps resetting” should become a sequence of before, event, and after observations. Without that timeline, source order, view order, and a user preference can be accidentally treated as the same concept.

## Define the expected order

Record whether the expected sequence comes from the authorized source, a prior Norva screen, a household preference, or a remembered arrangement. Capture exact category labels and parent view. Do not assume a manually observed order is a supported persistent setting.

The [category and metadata handbook](/blog/category-metadata-troubleshooting-handbook/) separates source data from presentation.

## Capture the before sequence

Number every visible category from first to last, or use a representative top and bottom subset if the list is large. Include duplicate-looking labels, empty categories, media type, source scope, and timestamp. Avoid screenshots that expose unrelated private titles.

## Freeze context

Record the Norva account, active profile, enabled sources, availability, year, rating, audio, subtitles, search, sorting, grouping, device, operating system, application version, and network. An order seen under another filter or profile is not a reset of the same view.

## List candidate triggers

Common observable events include leaving and reopening the page, signing out and in, switching profiles, closing and reopening the application, restarting the device, changing a filter, updating the application, updating the source, importing, or refreshing. This list identifies tests; it does not claim any event should preserve or change order.

## Test one event at a time

Choose one low-risk ordinary event, record the time, then capture the after sequence with the same context. Restore the baseline before another event where possible. Do not chain profile switches, imports, application updates, and device restarts into one test.

## Compare source order

Through the provider's official authorized route, record category order if the provider visibly exposes one. Note source changes and timestamps. Source order is evidence, not proof that Norva must mirror it or that the field controls every view.

The [duplicate-label guide](/blog/duplicate-category-names/) helps distinguish same-name categories during sequence comparison.

## Compare another supported device

Use the same account, profile, source selection, view controls, and close timestamp. Record both application versions. If categories are ordered differently, preserve a cross-screen result without claiming which order is saved centrally or locally.

The [hidden-category comparison](/blog/category-hidden-on-one-device/) provides a device-context matrix.

## Preserve update and recovery history

Record recent source imports, application updates, account changes, and incident recovery. If order changed after recovery, include it in the [post-recovery integrity audit](/blog/post-recovery-import-integrity-audit/) without assuming the recovery action caused it.

## Avoid repeated reordering

If current Norva controls expose an ordering action, record the supported action and result. Do not repeatedly drag, rename, hide, import, or edit source categories before isolating the first trigger. Never promise persistence beyond current documentation.

## Classify the result

Use expected order not documented, context mismatch, source order changed, sequence changes after one repeatable event, device-specific order, application-version difference, not reproduced, or unknown. Keep the repeatable observation separate from any theory about storage.

## Original evidence: category order trigger timeline

| Step | Event | Category sequence | Context changed? | Time |
| --- | --- | --- | --- | --- |
| Baseline | None |  | No |  |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| Other device | Compare |  | Device/version |  |

Record source order separately when it is visibly available.

## Common mistakes and limitations

- Assuming a custom order is supported or persistent.
- Comparing different profiles, filters, or parent views.
- Testing several events before recording the result.
- Ignoring duplicate labels in the sequence.
- Claiming local or server storage without evidence.
- Reordering repeatedly and losing the first trigger.

## Frequently asked questions

### Is category order supposed to be saved?

Use only current Norva documentation for that claim. Otherwise describe the observed sequence and trigger without promising persistence.

### Which event should I test first?

Start with the simplest ordinary event that preceded the change, while keeping every other context stable and recording before and after.

### What if devices show different orders?

Record both contexts, versions, and timestamps. That proves a cross-screen difference, not where or how order is stored.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
