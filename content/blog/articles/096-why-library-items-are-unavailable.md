---
content_id: "NVB-096"
title: "Why Some Library Items Appear Unavailable"
seo_title: "Why Media Library Items Are Unavailable"
meta_description: "Diagnose unavailable library items by checking the exact source version, availability filters, account state, network reachability, rights, and refresh status."
slug: "why-library-items-are-unavailable"
canonical_url: "https://norva.tv/blog/why-library-items-are-unavailable/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Product Evaluation & Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "Why does a library item appear unavailable in Norva?"
supporting_questions:
  - "How can I tell whether one version or every version is affected?"
  - "Which evidence should I collect before contacting support?"
audience:
  - "Norva users seeing unavailable items"
  - "People troubleshooting a connected source"
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
estimated_reading_minutes: 6
excerpt: "An unavailable card can reflect one source version, a filter, source reachability, account state, rights, or stale catalogue information rather than one universal cause."
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
parent_pillar: "/blog/what-is-norva-media-player/"
related_articles:
  - "/blog/hide-unavailable-media-items/"
  - "/blog/group-multiple-media-versions/"
  - "/blog/norva-troubleshooting-checklist/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "item-version availability matrix"
  summary: "A matrix compares exact versions across two devices and one known working control item before any broad reset."
  methodology: "Readers preserve filters, identify source and version, test connected reachability, compare a control item, then change one variable per step."
  asset_urls: []
---

# Why Some Library Items Appear Unavailable

> **In short:** “Unavailable” can describe the exact source version, not necessarily the entire title. Check active availability filters, grouped versions, source reachability, account and profile, network state, and whether the source still exposes the item. Norva cannot create access or rights that the connected source does not provide.

An unavailable card is useful status information, but it does not identify the cause by itself. Preserve the item details before hiding it or changing filters.

## Confirm the exact symptom

Record:

- title, episode, and displayed version;
- connected source;
- account and profile;
- device and app version;
- active filters;
- date and approximate time;
- whether artwork and metadata still load;
- exact message shown when the item is opened.

Do not include source credentials, private addresses, or recovery codes in screenshots.

## Inspect grouped versions

Norva can group media variants. One version may be unavailable while another remains usable. Open the detail view and inspect every displayed version before concluding that the whole title is affected.

Compare source, language badges, quality labels, and availability status, but treat badges as metadata rather than guaranteed playback proof. The guide to [grouping multiple media versions](/blog/group-multiple-media-versions/) explains how to choose and verify a specific variant.

## Reset the viewing filters, not the account

An availability filter can intentionally show, hide, or narrow items. Review:

- “hide unavailable” or equivalent availability state;
- source filter;
- category;
- year or rating filters;
- audio and subtitle filters;
- active sort and search query.

Clear filters through the interface and observe whether the card changes. Do not sign out, remove the source, or clear app data for a filter problem. If the goal is simply a cleaner library, use the [hide unavailable items workflow](/blog/hide-unavailable-media-items/).

## Check the source and a control item

While connected, open one known working item from the same source. This separates a title-specific symptom from broad source reachability.

- If the control item also fails, investigate source access, account state, and network.
- If the control item works, return to the exact affected version.
- If another version works, record the difference rather than repeatedly selecting the failed one.

Norva organises a compatible source the user owns or is legally authorised to use. Availability and rights remain tied to that source and media.

## Refresh in a controlled order

Use the least disruptive steps first:

1. clear the current search and filters;
2. return to the library and reopen the item;
3. refresh through the current in-app control if available;
4. verify network reachability;
5. close and reopen the app;
6. restart the device;
7. compare the same source and item on another supported device.

Avoid removing and reconnecting the source until you have recovery details and have preserved the evidence. The [complete Norva troubleshooting checklist](/blog/norva-troubleshooting-checklist/) provides the escalation sequence.

## Original evidence: item-version matrix

| Check | Version A | Version B | Control item |
| --- | --- | --- | --- |
| Source shown |  |  |  |
| Availability status |  |  |  |
| Opens details |  |  |  |
| Plays while connected |  |  |  |
| Same result on Device B |  |  |  |
| Active filters cleared | Yes / No | Yes / No | Yes / No |

This matrix identifies where the failure follows the version. It does not prove why the source marked an item unavailable.

## When to escalate

Contact the source provider through its official route when the item is missing or unavailable at the source itself. Contact Norva support when the source is reachable and the same item behaves inconsistently in Norva after controlled checks.

Send the exact item, version, device, app version, time, steps, filters, and control-item result. Never send a password or one-time code.

## Common mistakes and limitations

- Assuming one failed version means every version is unavailable.
- Hiding the item before preserving evidence.
- Leaving an audio, subtitle, or source filter active.
- Removing the source before testing a control item.
- Treating metadata badges as guaranteed media access.
- Expecting Norva support to change source rights.
- Changing several devices and settings at once.

Source catalogues and rights can change. An item that worked previously is not guaranteed to remain available.

## Frequently asked questions

### Why can I still see artwork for an unavailable item?

Metadata and playable media availability are separate states. A visible card does not prove that the selected source version is currently reachable.

### Should I hide unavailable items?

That is a browsing preference. Preserve and diagnose an unexpected status first; hide it later if you prefer a cleaner view.

### Can Norva restore an unavailable source item?

Norva can organise what a compatible authorised source exposes. It cannot create source access or rights that are absent.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva terms](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
