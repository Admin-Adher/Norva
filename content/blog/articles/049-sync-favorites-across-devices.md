---
content_id: "NVB-049"
title: "How to Keep Favorites Consistent Across Your Screens"
seo_title: "Sync Favorites Across Your Screens"
meta_description: "Keep Norva Favorites aligned across supported devices by checking the account, profile, item identity, connection, and latest edit."
slug: "sync-favorites-across-devices"
canonical_url: "https://norva.tv/blog/sync-favorites-across-devices/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Cross-Device & TV Experience"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can Favorites remain consistent across supported screens?"
supporting_questions:
  - "Why can a favorite appear on one screen but not another?"
  - "Are Favorites the same as playback progress?"
audience:
  - "Norva users saving titles on multiple supported devices"
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
estimated_reading_minutes: 5
excerpt: "Favorite consistency depends on the same account, profile, catalogue item, and connected state across supported devices."
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
parent_pillar: "/blog/playback-progress-sync-explained/"
related_articles:
  - "/blog/favorites-watchlists-continue-watching/"
  - "/blog/recent-favorites-all-titles/"
  - "/blog/playback-progress-sync-explained/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "two-screen favorite reconciliation card"
  summary: "A controlled add-check-remove cycle isolates account, profile, item identity, connectivity, and latest action."
  methodology: "The reader uses one reference title and changes only one screen at a time, without asserting a guaranteed sync delay."
  asset_urls: []
---

# How to Keep Favorites Consistent Across Your Screens

> **In short:** Use the same Norva account and profile on each supported device, then compare the same catalogue item and version. Add one reference favorite on a connected screen, verify it elsewhere, and avoid editing it on both screens during diagnosis. If it differs, check profile, item identity, source state, and connectivity in that order.

Favorites are deliberate personal choices. Their value comes from stability: a title saved on one screen should remain part of the same profile's shortlist on another supported screen.

## Separate Favorites from other states

Favorites answers “Did I choose to save this?” It is distinct from:

- Continue Watching, which reflects playback progress;
- Recent, which reflects current activity as defined by the interface;
- history, which records viewing activity;
- categories, which organise the connected catalogue.

For a full comparison, read [Favorites, watchlists, and Continue Watching](/blog/favorites-watchlists-continue-watching/).

Norva states that favourites, progress, history, and preferences synchronise across supported devices. Keeping the states conceptually separate makes discrepancies easier to diagnose.

## Establish one reference favorite

Choose a title with:

- an unambiguous name;
- one clearly identified version;
- current availability through the source;
- complete enough metadata to recognise on both screens.

On Device A:

1. confirm account and profile;
2. open the title details;
3. add it to Favorites;
4. return to the Favorites view and confirm it appears;
5. keep the device connected.

On Device B:

1. confirm the same account and profile;
2. open Favorites;
3. locate the same title and version;
4. inspect the title details before changing anything.

Do not assume a specific sync time. Observe the current state and collect context if it does not align.

## Use the reconciliation card

| Check | Device A | Device B |
| --- | --- | --- |
| Account |  |  |
| Profile |  |  |
| Title and version |  |  |
| Favorite state |  |  |
| Connection available |  |  |
| Last action and approximate time |  |  |

The card exposes a common source of confusion: two screens may display similar title cards that represent different versions or source records.

If identity is uncertain, use [the duplicate-title diagnostic](/blog/diagnose-duplicate-media-titles/) before toggling the favorite repeatedly.

## Resolve a one-screen mismatch

Check these possibilities one at a time:

### Different profile

Each profile can maintain personal state. Switch to the intended profile before comparing.

### Different item or version

Open details and compare the title, episode context, year, and version labels. A favorite belongs to a catalogue identity, not merely a poster.

### Connectivity

A screen that cannot connect may not show another device's latest account state. Reconnect before editing.

### Conflicting recent actions

If one screen adds while another removes the same favorite, the final state can be unclear to the viewer. Stop changing it, confirm the state on the most recently connected screen, then repeat the controlled reference test.

### Source change

If the underlying record has changed or become unavailable, the saved state may point to a record that is no longer presented identically. Verify the compatible source.

The [playback progress sync model](/blog/playback-progress-sync-explained/) uses the same account-profile-identity-connectivity checkpoints.

## Keep the shortlist useful

Consistency is not the same as size. A Favorite list becomes less helpful when nearly every item is saved.

Review it by intent:

- watch soon;
- revisit;
- share with this profile's household context;
- keep for a themed plan.

Remove entries that no longer serve a reason, using the controls present in the current interface. Compare [Recent, Favorites, and All Titles](/blog/recent-favorites-all-titles/) before turning Favorites into a complete library mirror.

## Common mistakes and limitations

- Comparing different profiles.
- Toggling the item repeatedly on two screens.
- Matching only on artwork.
- Expecting a disconnected device to reflect a new edit immediately.
- Treating unavailable as automatically removed from Favorites.
- Confusing Favorite state with playback progress.
- Assuming every supported screen presents the shortcut in the same location.

## Frequently asked questions

### Do Favorites follow the account or the device?

Norva synchronises favourites across supported devices as part of the account experience. Compare the same profile because personal state can differ between profiles.

### Why is the same poster not marked as a favorite on another screen?

The cards may represent different versions or source records, or the second device may be on another profile or lack the latest connected state. Compare details before toggling.

### Does removing a favorite delete the title?

No. Favorite is a personal saved state. It does not delete the underlying media from the compatible source.

## Your next step

[Explore Norva features](https://norva.tv/#features)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
