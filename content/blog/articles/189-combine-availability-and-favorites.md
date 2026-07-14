---
content_id: "NVB-189"
title: "How to Filter Favorites by Current Availability"
seo_title: "Filter Favorites by Current Availability"
meta_description: "Filter favorites by current availability without confusing durable preference with temporary source state, grouped versions, incomplete metadata, or stale catalogue data."
slug: "combine-availability-and-favorites"
canonical_url: "https://norva.tv/blog/combine-availability-and-favorites/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Filter Strategies"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should favorites be filtered by current availability?"
supporting_questions:
  - "Why should favorite state and availability state remain separate?"
  - "How should grouped versions and stale source state be checked?"
audience:
  - "People choosing from saved favorites that are currently available"
  - "Norva users troubleshooting favorite and availability combinations"
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
excerpt: "A reconciliation ledger keeps durable favourite intent separate from the changing availability of each version."
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
parent_pillar: "/blog/media-filter-strategy-guide/"
related_articles:
  - "/blog/diagnose-empty-filter-results/"
  - "/blog/find-hidden-active-filters/"
  - "/blog/create-repeatable-filter-recipes/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://guides.loc.gov/c.php?g=1472768&p=10988945"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "favourite-availability reconciliation ledger"
  summary: "A ledger separates saved preference, work identity, individual versions, source state, last refresh, and current playable match."
  methodology: "Readers validate favorites alone and availability alone, combine them, then reconcile unexpected omissions at version level with positive controls and refresh state."
  asset_urls: []
---

# How to Filter Favorites by Current Availability

> **In short:** Treat “favorite” as a durable preference and “available now” as temporary state. Validate each filter separately, then intersect them. For missing favorites, inspect every grouped version, connected-source scope, last refresh, profile, and metadata status. Do not remove a favorite merely because no current version is available; preserve preference and diagnose availability independently.

The combination answers a useful question: “Which saved choices can I use now?” It should not rewrite the saved list or imply that an unavailable favorite was a mistake.

## Separate the two states

A favorite usually belongs to a user or profile and can persist. Availability belongs to a source or version and can change. Model them as separate columns:

| Work | Favorite profile | Version | Connected source | Available now | Last checked | Reason if unknown |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

This favourite-availability reconciliation ledger prevents temporary source state from being confused with long-term intent.

## Validate favorites alone

Start from a clean baseline and activate only the favorites filter. Confirm:

- the active profile;
- one known favorite and one known non-favorite;
- whether favorite status belongs to the work or a version;
- whether grouped titles appear once or several times;
- the expected count or a recent reference count.

If the known favorite is absent already, availability is not yet the issue. Check profile sync, catalogue identity, grouping, and hidden search or category scope.

## Validate availability alone

Reset, then apply only the current-availability control. Use one known available version and one known unavailable record.

Define “available” carefully. Does it mean listed by any connected compatible source, directly usable now, or merely known to the catalogue? Confirm the interface's actual scope. Also record the last refresh time because stale state can make a correct filter look wrong.

## Combine the conditions

Apply favorites first, record the count, then current availability:

| State | Count | Known favorite visible? | Known available version visible? | Notes |
|---|---:|---|---|---|
| Favorites only |  |  |  |  |
| Availability only |  |  |  |  |
| Favorites + availability |  |  |  |  |

The combined list should contain records that satisfy both conditions in the current scope. It is a view over favorites, not a new favorite list.

The Library of Congress facet guidance notes that records missing the filtered field may disappear. If availability metadata is unknown, an omitted item is not proof that every version is unavailable.

## Reconcile grouped versions

When a favorite has several versions, inspect them individually. One version may be unavailable while another still matches. Conversely, a group may look available because one version exists even though the preferred language or quality version does not.

Record the matching version rather than assigning availability to the work in the abstract. This is particularly important when another filter—audio, subtitle, year, or source—is also active.

## Investigate an unexpected omission

Use this order:

1. Confirm the correct profile and favorite state.
2. Clear hidden query, category, and source restrictions.
3. Refresh the connected source if appropriate.
4. Inspect grouped versions independently.
5. Test the record with availability alone.
6. Capture the first state where it disappears.

If the intersection becomes empty, follow [the empty-result rollback ladder](/blog/diagnose-empty-filter-results/). If the interface looks clear but the count remains restricted, run [the hidden-filter sweep](/blog/find-hidden-active-filters/).

## Preserve the durable list

Do not unfavorite records simply to make the “available now” list cleaner. That destroys the distinction between preference and state. Instead, keep the favorite and use the combined view when making a current choice.

If this is a recurring task, document it as a recipe: profile, source scope, favorite condition, availability definition, refresh expectation, and optional sort. [The filter-recipe guide](/blog/create-repeatable-filter-recipes/) provides a maintainable format.

W3C notification guidance recommends that status messages explain outcomes and resolution. An availability refresh should state whether the check completed, whether items changed, and what the user can do if the result is empty.

Norva can sync favourites and organise compatible sources a user is authorised to access across supported devices, but current availability and metadata depend on those sources. Confirm the relevant version before acting on the filtered view.

## Common mistakes and limitations

- Deleting a favorite because it is temporarily unavailable.
- Ignoring profile scope.
- Treating work-level and version-level availability as identical.
- Forgetting a hidden source filter.
- Assuming unknown metadata means unavailable.
- Evaluating results during an incomplete refresh.

The ledger preserves state boundaries; it cannot guarantee future source availability.

## Frequently asked questions

### Should unavailable favorites remain visible somewhere?

Yes. Keep a complete favorites view and use availability as a temporary narrowing condition.

### Which filter should be applied first?

Favorites first is easier to inspect, although ordinary static AND logic should produce the same final intersection.

### Why is a grouped favorite missing?

Check each version, source scope, profile, refresh state, and any additional active condition.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [Library of Congress: Basic Search and facets](https://guides.loc.gov/c.php?g=1472768&p=10988945)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
