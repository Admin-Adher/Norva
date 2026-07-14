---
content_id: "NVB-272"
title: "How to Investigate a Favorite That Appears Missing"
seo_title: "Investigate a Favorite That Appears Missing"
meta_description: "Investigate a missing favorite with a state-location map covering identity, viewer scope, filters, source version, device sync, removal history, and recovery."
slug: "recover-missing-favorite"
canonical_url: "https://norva.tv/blog/recover-missing-favorite/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Favorites & Watchlists"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should a favorite that appears missing be investigated?"
supporting_questions:
  - "Which scope, filter, source, and sync checks should run first?"
  - "How can recovery avoid creating a duplicate favorite?"
audience:
  - "Viewers unable to find a saved title"
  - "Norva users troubleshooting favorite state"
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
excerpt: "A state-location map checks every place a favorite can become hidden, remapped, delayed, or removed before adding it again."
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
  - "/blog/separate-favorites-by-profile/"
  - "/blog/resolve-duplicate-favorites/"
  - "/blog/handle-unavailable-favorites/"
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
  type: "favorite state-location map"
  summary: "The map captures item identity, account/profile/device/source scope, active filters, alternate versions, last known state, sync observations, removal action, and recovery outcome."
  methodology: "Readers freeze the symptom, search by identity, clear filters, verify scope, compare one control device, inspect source/version changes, and add only after absence is confirmed."
  asset_urls: []
---

# How to Investigate a Favorite That Appears Missing

> **In short:** Do not add the title again immediately. Preserve its exact identity and last known state, clear filters, verify account and profile scope, search alternate title forms, inspect source or version changes, and compare one supported device. Re-add only after the original favorite is confirmed absent; otherwise you may create a duplicate-looking entry.

A favorite can appear missing because the item is filtered, scoped to another viewer, represented by another version, temporarily unavailable, delayed in synchronization, or actually removed. The card’s disappearance and the preference record’s deletion are not the same claim.

## Build the state-location map

| Location or layer | Observation |
|---|---|
| Exact work and version identity |  |
| Last known favorite state and time |  |
| Account and profile/viewer context |  |
| Device and app/browser version |  |
| Active filters and sort |  |
| Connected source and availability |  |
| Alternate titles or versions |  |
| Other-device result |  |
| Known removal action |  |
| Recovery result |  |

Do not include passwords, tokens, or private source addresses.

## Freeze the symptom

Capture the favorites view, active filter chips, viewer label, search query, and check time. Avoid clearing cache or signing out before the baseline exists. W3C notification guidance supports preserving the exact status message if the interface reports a sync or source issue.

## Verify exact identity

Record title, media type, release context, series relationship, stable identifiers, and version attributes. DCMI metadata terms distinguish identifier, title, type, relation, format, and language. Search by alternate title and identifier where exposed.

A remapped version can make the old card vanish while the underlying work remains findable.

## Clear discovery constraints

Reset:

- media type;
- source;
- availability;
- language;
- year;
- watched state;
- search text;
- custom shortlist or profile scope.

Clear one group at a time and record when the item returns. “All” still operates inside the active account and source context.

## Verify viewer and profile scope

Use [the profile-scope test](/blog/separate-favorites-by-profile/) to determine whether the favorite belongs to another confirmed context. Do not switch several accounts and devices simultaneously. A favorite missing from the wrong profile may be correct behavior.

## Inspect source and version changes

If the source record became unavailable or was regrouped, search the canonical work identity and compare variants. Use [the unavailable-favorite workflow](/blog/handle-unavailable-favorites/) before replacing the card.

Do not transfer state by title or artwork alone.

## Compare one control device

On another supported device under the same intended context, record:

- whether the item appears;
- its work and version identity;
- favorite control state;
- source availability;
- last refresh time.

If one device shows the favorite and one does not, treat it as a synchronization or local presentation issue. Do not re-add yet.

## Re-add only after confirmed absence

When identity, scope, filters, source, and sync have been checked and the favorite is genuinely absent:

1. add the exact intended version once;
2. leave the detail page;
3. retrieve it from favorites;
4. check the control device;
5. compare for duplicates;
6. verify history and progress remain separate.

If a duplicate appears, use [the duplicate-favorite diff](/blog/resolve-duplicate-favorites/).

Use one timestamped test item so the re-add can be distinguished from an older synchronized copy.

Norva may retain favorites across supported devices under the same account. Exact profile and synchronization behavior should be verified in current support documentation.

## Escalate safely

Report safe work identifiers, timestamps, devices, context labels, and reproduction steps. Redact credentials and unrelated viewing history. State “favorite not visible in context A” rather than “deleted from server” unless support evidence confirms deletion.

## Common mistakes and limitations

- Re-adding before checking filters and scope.
- Searching only one title form.
- Treating unavailability as favorite deletion.
- Changing several contexts at once.
- Clearing state before capturing evidence.
- Sharing private source details in screenshots.

## Frequently asked questions

### Can a favorite be hidden by watched-state filters?

Yes, if the current interface offers that filter. Record active constraints and clear them deliberately.

### What if it exists on only one device?

Preserve both states and investigate synchronization or local cache before modifying the favorite.

### Should I create an external backup?

For valuable curation, a minimal private list of identities and intents can support recovery without storing sensitive account data.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
