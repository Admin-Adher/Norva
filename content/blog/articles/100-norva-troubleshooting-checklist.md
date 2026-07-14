---
content_id: "NVB-100"
title: "The Norva Troubleshooting Checklist: Setup, Sync, Search, and Playback"
seo_title: "Norva Setup, Sync, Search and Playback Fixes"
meta_description: "Troubleshoot Norva methodically across setup, account, source, sync, search, playback, TV, and offline layers without losing useful evidence."
slug: "norva-troubleshooting-checklist"
canonical_url: "https://norva.tv/blog/norva-troubleshooting-checklist/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "troubleshooting"
topic_cluster: "Product Evaluation & Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How should I troubleshoot Norva setup, sync, search, and playback problems?"
supporting_questions:
  - "Which checks should happen before resets?"
  - "What evidence should I collect for support?"
audience:
  - "Norva users troubleshooting any core workflow"
  - "Support users preparing a reproducible report"
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
excerpt: "A layered Norva diagnostic preserves evidence, isolates account, source, device, network, and media variables, and escalates only after low-risk checks."
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
  - "/blog/playback-progress-not-syncing/"
  - "/blog/offline-download-failed-checklist/"
  - "/blog/why-library-items-are-unavailable/"
cta:
  label: "Contact Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://norva.tv/#features"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/#faq"
  - "https://norva.tv/privacy"
  - "https://norva.tv/terms"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "layered troubleshooting record"
  summary: "A reusable incident form captures expected versus observed behaviour, one control item, one variable per step, and a safe escalation package."
  methodology: "Readers preserve the baseline, classify the failing layer, perform reversible checks from least to most disruptive, and stop when evidence identifies the cause or support boundary."
  asset_urls: []
---

# The Norva Troubleshooting Checklist: Setup, Sync, Search, and Playback

> **In short:** Preserve the symptom, then identify the failing layer: account/profile, compatible source, exact media item, device/app, network, or conditional rights. Test one known control item and change one variable at a time. Use low-risk refresh and restart steps before signing out, reconnecting a source, clearing app data, or reinstalling.

Most difficult support cases become difficult because the original state disappears. A methodical record protects useful evidence and avoids turning one problem into three.

## Step 1: describe expected and observed behaviour

Write one sentence for each:

- **Expected:** the exact action and result you intended.
- **Observed:** the visible result, error, or unexpected destination.

Add:

- date and approximate time;
- device, operating system or browser, and app version;
- Norva account and profile without credentials;
- connected source label without private addresses;
- exact title, episode, and version when relevant;
- network type;
- active search query and filters;
- screenshot or short recording with sensitive details removed.

Never include passwords, one-time codes, recovery codes, payment details, or secret source information.

## Step 2: classify the layer

Use the symptom to choose a starting layer:

| Symptom | First layers to check |
| --- | --- |
| Cannot sign in | Network, Norva account, device clock, current service route |
| Source will not connect | Source credentials, source reachability, compatibility, authorisation |
| One item fails | Exact version, source availability, media tracks, rights |
| Search misses items | Query, filters, category, source catalogue, refresh |
| Progress differs | Account, profile, item version, connectivity, sync state |
| TV focus or Back misbehaves | TV app, remote, focus context, current version |
| Offline item fails | Eligibility, completion, storage, account, device |

This is a triage map, not a final diagnosis.

## Step 3: establish a control

Choose one known working item or workflow from the same source. Compare it without changing the account or device.

- If one item fails and the control works, focus on the item or version.
- If every item fails, focus on source, account, network, or device.
- If one device fails and another works under the same account and source, focus on device state or app version.
- If both devices fail identically, verify the source and account before resetting either.

For unavailable cards, use the [item-version availability matrix](/blog/why-library-items-are-unavailable/).

## Step 4: perform reversible checks first

In order:

1. verify the intended account and profile;
2. clear search text and active filters;
3. confirm the exact source and item version;
4. verify the device has a working connection;
5. use the current in-app refresh route if available;
6. close and reopen the affected view;
7. close and reopen the app or browser tab;
8. restart the device;
9. check for official app and operating-system updates;
10. repeat the control test.

Record the result after every step. Stop when the symptom changes; the last variable is valuable evidence.

## Setup and source checks

Norva organises a compatible source that the user owns or is legally authorised to use. The subscription does not include a catalogue or media access.

When setup fails:

- verify the source through its official route;
- confirm credentials without sharing them;
- check account recovery before signing out;
- confirm the source remains compatible under current documentation;
- avoid repeatedly reconnecting with uncertain details;
- preserve exact error text.

Norva cannot create source access, data, or rights that are absent.

## Sync and profile checks

For progress, favourites, history, or preferences:

1. confirm the same account and intended profile;
2. compare the same item and version;
3. create one clean checkpoint while connected;
4. allow the state to settle;
5. inspect the second device before playing;
6. avoid simultaneous changes on both devices.

The [playback progress sync guide](/blog/playback-progress-not-syncing/) provides a detailed two-device log. Do not promise an exact sync time.

## Search and catalogue checks

Clear filters, then search for an exact known title and a control item. Verify category, source, availability, year, audio, and subtitle filters. Inspect grouped versions before concluding that a title is absent.

If the source does not expose the item or metadata, Norva cannot invent it. Record whether the mismatch exists at the source or only in Norva.

## Playback and TV checks

Separate:

- failure to open details;
- failure to start playback;
- buffering after start;
- missing media tracks;
- remote focus delay;
- unexpected Back navigation.

Use a known item, clear filters, and test remote focus on an already loaded screen. Network delay and interface delay are not the same. Avoid rapid repeated button presses.

## Offline checks

Offline access depends on the device, source, media, and associated rights. Confirm eligibility, free storage, completed transfer, and a genuine airplane-mode test.

If a transfer fails, preserve the error and follow the [offline download diagnostic checklist](/blog/offline-download-failed-checklist/). Do not clear all app data before trying item-level removal.

## Original evidence: layered incident record

| Field | Record |
| --- | --- |
| Expected behaviour |  |
| Observed behaviour |  |
| Layer suspected | Account / Source / Item / Device / Network / Rights / Unknown |
| Control test |  |
| Variable changed |  |
| Result |  |
| Last known working time |  |
| Safe attachment prepared | Yes / No |

Add a chronological list of steps. This record lets support reproduce the issue without collecting secrets.

## Broad actions and escalation

Signing out, removing a source, clearing app storage, or reinstalling can erase useful state and offline items. Use them only after preserving evidence, confirming recovery access, reading platform warnings, and receiving appropriate guidance.

Contact the source provider when the source itself is unavailable or incorrect. Contact Norva support when a reproducible difference remains inside Norva after the source and control workflow are verified.

## Common mistakes and limitations

- Reporting “it does not work” without an exact action.
- Changing several variables together.
- Comparing different profiles or versions.
- Resetting both devices at once.
- Sharing credentials in screenshots.
- Treating missing source data as a guaranteed Norva defect.
- Reinstalling before preserving evidence.
- Assuming every issue has one universal fix.

Product, device, network, and source conditions change. Reproduce the issue close to the report time.

## Frequently asked questions

### What should I try first?

Verify the account, profile, source, item version, filters, and connection. Then refresh the view and test one known control item before restarting anything.

### When should I reinstall Norva?

Only after less disruptive checks, evidence capture, recovery verification, and appropriate support or platform guidance. Reinstallation can remove local state.

### What should I send support?

Send expected and observed behaviour, steps, device and app versions, time, item or source label, control result, and a redacted screenshot. Never send passwords or secret access details.

## Your next step

[Contact Norva support](https://norva.tv/support)

## Sources

- [Norva features](https://norva.tv/#features)
- [How Norva works](https://norva.tv/#how-it-works)
- [Norva FAQ](https://norva.tv/#faq)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)
