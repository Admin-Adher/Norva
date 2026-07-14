---
content_id: "NVB-279"
title: "How to Verify Favorites After Moving to a New Device"
seo_title: "Verify Favorites After Moving to a New Device"
meta_description: "Verify favorites on a new device with a migration checksum for account, profile, source, item identity, list count, filters, versions, retrieval, sync, and rollback evidence."
slug: "rebuild-favorites-after-device-move"
canonical_url: "https://norva.tv/blog/rebuild-favorites-after-device-move/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Favorites & Watchlists"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should favorites be verified after moving to a new device?"
supporting_questions:
  - "Which migration checks distinguish sync from filter problems?"
  - "How can rebuilding avoid duplicate favorites?"
audience:
  - "Viewers setting up favorites on a replacement device"
  - "Norva users validating cross-device state"
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
excerpt: "A migration checksum proves which favorites arrived intact before any manual rebuilding creates duplicates or changes the source of truth."
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
  - "/blog/separate-favorites-by-profile/"
  - "/blog/resolve-duplicate-favorites/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "cross-device favorites migration checksum"
  summary: "The checksum compares account, profile, source, count, representative identities, filters, versions, retrieval, add/remove propagation, and rollback state."
  methodology: "Readers preserve the old device as reference, verify context, compare a stratified sample, test one reversible favorite, and rebuild only confirmed absences."
  asset_urls: []
---

# How to Verify Favorites After Moving to a New Device

> **In short:** Keep the old device unchanged as a reference. On the new device, verify account, profile, connected source, filters, and app state before comparing favorites. Test a representative sample and one reversible add/remove action. Manually rebuild only confirmed absences, or you may create duplicates while synchronization is still pending.

A device move is a state-verification task, not a reason to recreate every favorite from memory. Counts alone can match while versions or viewer scope differ.

## Build the migration checksum

| Check | Old device | New device |
|---|---|---|
| Account and viewer/profile |  |  |
| Compatible source state |  |  |
| App/browser version |  |  |
| Favorite count with filters clear |  |  |
| Earliest/oldest sample |  |  |
| Recent sample |  |  |
| Series and episode sample |  |  |
| Version-specific sample |  |  |
| Unavailable sample |  |  |
| Reversible add/remove result |  |  |

Record timestamps and do not expose credentials.

## Preserve the reference device

Do not sign out, clear data, or bulk-edit the old device until verification ends. Capture a minimal identity list and active profile label. A screenshot should exclude private notifications and source details.

## Match context first

Confirm the same intended account, viewer or profile, and authorized source. Similar display names are insufficient. Use [the profile-scope test](/blog/separate-favorites-by-profile/) when household separation matters.

Clear filters and search on both devices. Different availability filters can make a synchronized favorite look missing.

## Compare a stratified sample

Choose at least one:

- long-standing favorite;
- recently saved item;
- series-level favorite;
- episode or version-specific favorite;
- currently unavailable favorite;
- item with non-default language requirements.

Confirm exact identifiers, media type, version, and favorite state. DCMI metadata terms distinguish identifier, type, relation, format, and language—useful fields for more than a simple count.

## Test retrieval, not just presence

Open each sample from favorites and verify the intended work or version. A card can exist while routing to a default variant that does not meet the original purpose.

If a known item is absent, follow [the missing-favorite recovery map](/blog/recover-missing-favorite/) before adding it.

## Run one reversible sync test

1. Choose a non-critical item absent from favorites.
2. Add it on the old or designated source-of-truth device.
3. Record time and context.
4. Observe the new device after the verified normal refresh action.
5. Remove the test item.
6. Confirm both return to baseline.

W3C notification guidance supports clear sync status and recovery. If timing is unknown, classify pending rather than failed.

## Rebuild only confirmed gaps

For every genuine absence, match exact identity and add once. Reopen it, compare the old device, and inspect for duplicates. Use [the duplicate-favorite diff](/blog/resolve-duplicate-favorites/) if two cards appear.

Norva may retain favorites across supported devices under the same account. Exact sync timing and profile scope should be checked in current support documentation.

## Retire the old device safely

After favorites, versions, progress, and other required account state are separately verified, follow the platform’s normal sign-out or device removal procedure. Do not infer device limits or simultaneous-use rules; consult current product documentation.

Keep the migration checksum until the new device has passed one normal review cycle. Then remove screenshots or notes containing device context that are no longer needed.

## Define a migration acceptance gate

Accept the new device only when the intended account and profile are confirmed, filters are clear, representative favorites reopen correctly, one version-specific item retains its purpose, and the reversible test returns both devices to baseline. A mismatch in any critical sample keeps the old reference available and moves the device change into investigation; it does not justify recreating the entire list.

## Common mistakes and limitations

- Rebuilding from memory before sync checks.
- Comparing different profiles or filters.
- Using counts without identity samples.
- Clearing the old device too early.
- Treating delayed state as permanent loss.
- Assuming a present card opens the right version.

## Frequently asked questions

### Must every favorite be checked?

Use a representative sample first. Audit every item only when risk, list size, or detected mismatches justify it.

### What if counts differ but all important items exist?

Identify the extra or missing records; unavailable, duplicate, or profile-scoped items can explain the difference.

### Which device is the source of truth?

Do not assume. Preserve both states and use current product support when synchronization behavior is unclear.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
