---
content_id: "NVB-229"
title: "How to Diagnose a Resume Point Attached to the Wrong Episode"
seo_title: "Diagnose a Resume Point on the Wrong Episode"
meta_description: "Diagnose a wrong-episode resume point by preserving evidence, separating profile, hierarchy, source item, version, and sync state, then repairing only the failed mapping."
slug: "fix-wrong-episode-resume-context"
canonical_url: "https://norva.tv/blog/fix-wrong-episode-resume-context/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Series Library Workflows"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can a resume point attached to the wrong episode be diagnosed?"
supporting_questions:
  - "Which layers can misattach series progress?"
  - "How can state be repaired without losing valid progress?"
audience:
  - "People whose continue action opens the wrong episode"
  - "Norva users troubleshooting episode-specific progress"
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
excerpt: "A resume-context isolation matrix finds whether the wrong episode originates in profile state, hierarchy, identifier mapping, version grouping, or synchronization."
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
  - "/blog/verify-next-episode/"
  - "/blog/find-gaps-in-episode-sequence/"
  - "/blog/audit-series-after-source-update/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.eidr.org/how-we-work"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "resume-context isolation matrix"
  summary: "A matrix compares expected and actual profile, series, season, episode, source item, version, saved position, device state, and last update before any repair."
  methodology: "Readers capture the erroneous launch, reproduce it once without overwriting state, validate each layer from profile to item, repair the first failed mapping, and rerun the next-episode checksum."
  asset_urls: []
---

# How to Diagnose a Resume Point Attached to the Wrong Episode

> **In short:** Do not immediately mark episodes watched or drag the progress bar. Capture the expected episode and position, the episode that actually opens, active profile, device, source, version, identifiers, and update time. Reproduce once only if safe, then inspect profile state, hierarchy, episode mapping, grouped versions, and synchronization in that order. Repair the first failed layer and revalidate the next episode.

A resume error can look identical at the surface while originating in different layers: another profile's progress, wrong parentage, duplicate identifiers, a grouped edit, stale device state, or a source metadata change.

## Preserve the wrong launch

Record before altering anything:

- expected series, season, episode, and position;
- displayed continue label;
- actual series, season, episode, and position;
- profile/account context;
- device and app version if available;
- connected source and item;
- time of last known correct state;
- screenshots that avoid revealing sensitive data.

Stop playback quickly when doing so will not destroy evidence. Do not mark the actual episode complete.

## Build the isolation matrix

| Layer | Expected | Actual | Pass? | Evidence |
|---|---|---|---|---|
| Profile |  |  |  |  |
| Series ID |  |  |  |  |
| Season parent |  |  |  |  |
| Episode ID |  |  |  |  |
| Source item |  |  |  |  |
| Edit/version |  |  |  |  |
| Saved position |  |  |  |  |
| Device/sync state |  |  |  |  |

EIDR's public hierarchy separates series, seasons, episodes, edits, and manifestations. A resume point should resolve through those layers to one playable item rather than attach to the poster or number alone.

## Check profile first

Confirm the active profile or equivalent personal context. Household viewers can legitimately have different completed episodes. If the product does not support separate profiles, compare against the household progress ledger rather than assuming whose state is visible.

Do not modify another viewer's progress to repair your own.

## Validate hierarchy and identity

Compare stable identifiers, parent season, title, distribution number, alternate numbers, release date, and runtime. If the episode is mapped to the wrong season or a duplicate record, progress may follow the mistaken identity.

Use [the episode-gap audit](/blog/find-gaps-in-episode-sequence/) when surrounding numbers or parentage are inconsistent.

## Inspect grouped versions

The correct episode work may have several source entries or edits. Check whether progress belongs to a different version and whether grouping merged items with conflicting identifiers.

Record both item IDs. Do not transfer a percentage between versions until scene alignment is verified.

## Compare device and sync state

Open a second supported device only as a controlled read-only comparison. Note whether it shows the expected or wrong state and the last update time. A difference can indicate delayed synchronization, device-local state, or a recent overwrite; it does not by itself prove which copy is authoritative.

Norva may sync progress across supported devices under one account, but exact timing and conflict behavior should be verified in current documentation or with support.

## Repair the first failed layer

Possible actions:

- switch to the correct profile;
- correct source/episode mapping through supported controls;
- select the correct version explicitly;
- wait for a documented refresh or sync completion;
- report wrong hierarchy or duplicate identity;
- restore a known position only after identity is correct.

Do not perform several repairs at once. Preserve the cause-and-effect transition.

## Rerun the preflight

Use [the next-episode checksum](/blog/verify-next-episode/) to confirm expected series, season, episode, version, tracks, and availability. Then test one controlled launch.

After any source metadata change, run [the series post-update audit](/blog/audit-series-after-source-update/) across the surrounding episodes.

W3C notification guidance recommends clear feedback and recovery. A progress repair should state which episode and position changed and make accidental actions reversible where possible.

## Common mistakes and limitations

- Overwriting progress before capturing evidence.
- Comparing episode numbers without identifiers.
- Ignoring profile context.
- Copying percentages across versions.
- Triggering repeated sync conflicts during testing.
- Fixing several layers in one step.

## Frequently asked questions

### Should I mark the correct episode complete manually?

Only after identity and actual viewing state are verified. Manual completion can hide the original mapping fault.

### What if every device shows the wrong episode?

Check hierarchy, source mapping, grouped versions, and server-side state; provide the isolation matrix to support.

### Can source metadata changes cause this?

Yes. Changed identifiers, parentage, numbering, or grouping can break the mapping between saved state and a playable item.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
