---
content_id: "NVB-456"
title: "How to Audit Profile Separation Across Supported Devices"
seo_title: "Audit Profile Separation Across Supported Devices"
meta_description: "Audit household profile separation across supported screens with controlled items, state fingerprints, privacy-safe evidence, and pass criteria for each device pair."
slug: "how-to-audit-profile-separation-across-supported-devices"
canonical_url: "https://norva.tv/blog/how-to-audit-profile-separation-across-supported-devices/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Household Profiles"
search_intent: "profile separation device audit"
funnel_stage: "retention"
primary_question: "How can I audit profile separation across supported devices?"
supporting_questions:
  - "Which profile states should remain distinct?"
  - "How can I test without exposing private activity?"
audience:
  - "Households using Norva on several screens"
  - "People verifying profile context after device handoff"
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
  source_of_truth: "https://norva.tv/#features; https://norva.tv/#pricing; https://norva.tv/#how-it-works; https://norva.tv/privacy; https://norva.tv/terms; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 5
excerpt: "Audit household profile separation across supported screens with controlled items, state fingerprints, privacy-safe evidence, and pass criteria for each device pair."
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
parent_pillar: "/blog/the-complete-guide-to-household-media-profiles/"
related_articles:
  - "/blog/the-complete-guide-to-household-media-profiles/"
  - "/blog/how-to-confirm-the-active-profile-before-playback/"
  - "/blog/build-a-device-to-device-handoff-test-matrix/"
cta:
  label: "Review Norva's Cross-Device Features"
  href: "https://norva.tv/#how-it-works"
  intent: "retention"
sources:
  - "https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html"
  - "https://norva.tv/#how-it-works"
  - "https://norva.tv/privacy"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "profile-separation device matrix"
  summary: "A controlled matrix verifies profile labels, test-item progress, favourites, and language intent on each supported device without copying full private histories."
  methodology: "Households select privacy-safe reference items, capture a small state fingerprint per profile, test one device at a time, and classify observed separation as pass, partial, or fail."
  asset_urls: []
---
# How to Audit Profile Separation Across Supported Devices

> **In short:** Choose two approved profiles and privacy-safe reference items, then verify profile label, item progress, favourite state, and language intent on each supported device. Test one device at a time, never copy full histories, and define pass criteria before starting. A good audit confirms organisational separation; it does not attempt to prove account security or universal device compatibility.

Cross-device preservation makes profile selection important on every screen. An audit checks whether household routines and visible state keep contexts distinct.

Before testing, agree who may view each reference state and where results will be stored. Assign one coordinator so two people do not change the same profile on different devices while the audit is running. Record the starting state and return every device to it after inspection.

## Define the audit scope

List only supported devices the household actually uses. Give each a role: shared TV, personal tablet, mobile screen, or compatible-browser station. Do not build a public compatibility chart from household observations.

Choose which states matter:

- profile label;
- progress on a reference item;
- one intentional favourite;
- audio preference;
- subtitle preference;
- clean sign-in or handoff state.

## Obtain profile-owner agreement

Ask each owner to approve the reference item and visible fields. Avoid private titles, full history, or recommendation lists. Store no credentials or source URLs.

Norva's privacy policy describes product data practices; household consent still governs what people review together.

## Create a state fingerprint

For each profile, record a different authorised item or a clearly different position on the same harmless item. Add one favourite and language intent only if already genuine.

Do not create artificial progress merely for the audit when a neutral existing state is available.

## Test one device at a time

1. Open the verified Norva route.
2. Confirm account.
3. Read the profile label.
4. Find the reference item.
5. Record proposed progress.
6. Check the chosen favourite.
7. Inspect audio/subtitle intent.
8. Exit without altering state.

Use [the active-profile check](/blog/how-to-confirm-the-active-profile-before-playback/) before every row.

## Test a handoff separately

After static inspection, run one controlled source-to-target move. Keep the source paused and verify the target profile before media. The [device-to-device handoff matrix](/blog/build-a-device-to-device-handoff-test-matrix/) provides directional test rows.

W3C consistent-identification guidance supports stable labels, but the product's actual profile presentation must be observed.

## Original evidence: separation matrix

| Device | Profile label | Reference item/position | Favourite clue | Language intent | Result |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  | Pass / Partial / Fail |
|  |  |  |  |  | Pass / Partial / Fail |

“Partial” means the profile is correct but a state needs manual correction. A “fail” must describe the exact visible mismatch.

## Handle a mismatch

Pause before playback. Verify the account, profile, item, and version. Record the unexpected state and compare another supported device only if that changes one variable.

Do not clear history, reset profiles, or reinstall before preserving evidence.

If only one state differs, repeat that single row after confirming the same item and version. Do not rerun the entire matrix until the narrow mismatch is understood.

## Close the audit

Tell profile owners what was checked and what was not. Delete temporary screenshots and notes when no longer needed. Update the household device inventory only with structural conclusions.

The [complete household profile guide](/blog/the-complete-guide-to-household-media-profiles/) covers naming and shared-screen routines.

## Common mistakes and limitations

Avoid inspecting private history, testing every device simultaneously, creating fake activity, and treating one pass as a security certification.

Device support, app versions, source availability, and network state can change. This audit verifies observed profile separation in a limited environment.

## Frequently asked questions

### Must both profiles use the same reference item?

No. Distinct harmless items can make separation easier to observe, provided identity is documented.

### Does separate progress prove account privacy?

No. Profiles organise state; they do not secure a signed-in account from someone with access.

### How often should the audit run?

Use triggers such as a new device, profile change, update, or repeated mix-up rather than an arbitrary schedule.

## Your next step

[Review Norva's cross-device features](https://norva.tv/#how-it-works)

## Sources

- [W3C: Understanding Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html)
- [Norva: How It Works](https://norva.tv/#how-it-works)
- [Norva Privacy Policy](https://norva.tv/privacy)
