---
content_id: "NVB-864"
title: "Import Finished With Zero Items? Separate the Causes"
seo_title: "Import Finished With Zero Items? First Checks"
meta_description: "Troubleshoot a completed zero-item import by separating source content, authorization, connection details, profile, filters, categories, eligibility, and view."
slug: "import-finishes-with-zero-items"
canonical_url: "https://norva.tv/blog/import-finishes-with-zero-items/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "zero-item-import-troubleshooting"
topic_cluster: "Import & Sync Troubleshooting"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can I troubleshoot a completed import that shows zero items?"
supporting_questions:
  - "How can source content, authorization, connection details, filters, categories, eligibility, and display be separated?"
  - "Which privacy-safe samples and counts should be recorded?"
audience:
  - "Norva users seeing an empty completed import"
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
excerpt: "A zero-item investigation confirms the operation completed, then separates source content and access from connection identity, account scope, filters, category visibility, eligibility, and device display."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: false
parent_pillar: "/blog/catalog-import-sync-troubleshooting-handbook/"
related_articles:
  - "/blog/catalog-import-sync-troubleshooting-handbook/"
  - "/blog/catalog-import-will-not-start/"
  - "/blog/expected-items-missing-after-sync/"
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
  type: "zero-item cause separation worksheet"
  summary: "A worksheet records completion evidence, source content and authorization, masked connection identity, account and profile, filters, categories, eligibility clues, device comparison, and a privacy-safe expected sample."
  methodology: "The user confirms completion, freezes display controls, verifies the source through its official route, checks one expected sample, changes one reversible view control, and escalates observations without exporting the catalog."
  asset_urls: []
---

# Import Finished With Zero Items? Separate the Causes

> **In short:** First confirm the operation completed and record its exact result, time, account, profile, device, version, and source label. Then separate whether the authorized source currently contains expected media, whether access and connection identity are correct, whether filters or categories hide results, whether entries meet visible eligibility, and whether one device shows stale state. Test a tiny sample and avoid repeated imports or full exports.

Zero items is different from an operation that never started. The completion evidence narrows the investigation, but it does not prove why the visible catalog is empty.

## Preserve the completion result

Record the exact message, displayed count, start and completion times, masked source label, account, profile, device, application version, and network. Capture a redacted screenshot when useful. Do not immediately trigger another import and overwrite the clean sequence.

The [import-start guide](/blog/catalog-import-will-not-start/) covers cases without a completion result.

## Verify source content and access

Through the source provider's current official route, confirm that the authorized account can see expected media and that access has not expired or changed. Record aggregate observations and one privacy-safe sample code. A provider catalog that is genuinely empty can explain the result without implying a Norva defect.

Do not paste credentials or complete source addresses into notes.

## Confirm connection identity

Compare the privacy-safe source label, documented provider, account owner, and protected connection record. A typo, obsolete address, different account, or retired source may return a valid but unintended result. Inspect secrets only in their protected store and never copy them into the worksheet.

If source authorization is uncertain, stop and resolve it before further tests.

## Freeze account and profile scope

Verify the expected Norva account and active profile. If another authorized profile is used for comparison, record it as a separate context. Do not assume every profile exposes identical state or preferences.

## Clear only visible view restrictions

Record category, availability, source selection, year, rating, audio, subtitles, sort, search query, and grouping where shown. Remove one visible filter, return to the baseline, and record whether the count changes. A hidden result is a view observation, not proof that the import contained zero entries.

The [missing-item checklist](/blog/expected-items-missing-after-sync/) helps when only some entries remain absent.

## Inspect categories and eligibility clues

Record which categories appear, whether they are empty, and whether the source provider distinguishes content types, permissions, regions, or household roles. Do not invent Norva inclusion rules. If official support documents eligibility requirements, cite the current page and compare only visible evidence.

## Compare one supported device

On another trusted supported device, use the same account, profile, source selection, filters, grouping, and approximate time. Record application versions. If the other device shows entries, classify the symptom as device-specific display evidence, not as a proven cache failure.

Use the [one-device stale-catalog guide](/blog/one-device-shows-old-catalog/) before clearing local data.

## Test a known expected sample

Choose one item the authorized source currently shows. Record a neutral sample code, media type, category, year, and source version cues. Search for it with filters documented. One absent sample cannot characterize the entire catalog, but it gives support a concrete comparison.

## Avoid destructive shortcuts

Do not remove and reconnect the source, rotate working credentials, erase application data, bulk-edit categories, or issue repeated imports before support reviews the baseline. These actions can create a second problem and destroy the original evidence.

## Original evidence: zero-item cause separation worksheet

| Layer | Observation | Verified through | Result |
| --- | --- | --- | --- |
| Completion message and count |  | Norva UI |  |
| Source content and access |  | Official source route |  |
| Connection identity |  | Protected record |  |
| Account and profile |  | Norva UI |  |
| Filters and categories |  | Norva UI |  |
| Expected sample |  | Source and Norva |  |
| Second device |  | Supported device |  |

## Common mistakes and limitations

- Treating zero items as “did not start.”
- Repeating the import before saving completion evidence.
- Comparing different profiles or filter states.
- Assuming an empty view proves an empty imported dataset.
- Inventing undocumented eligibility or matching rules.
- Sharing credentials or exporting a complete private catalog.

## Frequently asked questions

### Does zero items mean the source is empty?

Not necessarily. Confirm source content, access, connection identity, account scope, filters, categories, and device display separately.

### Should I reconnect the source immediately?

No. Preserve the completed result and use current Norva support guidance before changing a working connection record.

### How many samples should I check?

Use the smallest set that represents the issue, usually one expected item plus aggregate category observations, while protecting household privacy.

## Your next step

[Open Norva Support](https://norva.tv/support)

## Sources

- [Norva support](https://norva.tv/support)
- [Norva privacy policy](https://norva.tv/privacy)
- [Norva terms of service](https://norva.tv/terms)
