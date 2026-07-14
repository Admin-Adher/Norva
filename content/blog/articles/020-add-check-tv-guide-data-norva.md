---
content_id: "NVB-020"
title: "How to Add and Check TV Guide Data in Norva"
seo_title: "How to Add and Check TV Guide Data in Norva"
meta_description: "Add authorised guide information through Norva’s current source flow, then verify programme identity, timing, descriptions, and time-zone context."
slug: "add-check-tv-guide-data-norva"
canonical_url: "https://norva.tv/blog/add-check-tv-guide-data-norva/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical_how_to"
topic_cluster: "Norva Setup & Account"
search_intent: "instructional"
funnel_stage: "retention"
primary_question: "How do I add TV guide data in Norva and check its matching?"
supporting_questions:
  - "What should be prepared?"
  - "How can a time shift be diagnosed?"
  - "What evidence helps support?"
audience:
  - "Norva users adding programme information"
  - "Users diagnosing incomplete schedules"
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
  source_of_truth: "https://norva.tv/privacy; https://norva.tv/terms; https://norva.tv/support"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "Add guide information from an authorised source, refresh once, and compare one known programme’s identity, time, and description before changing settings."
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
parent_pillar: "/blog/norva-getting-started/"
related_articles:
- "/blog/tv-guide-data-explained/"
- "/blog/verify-media-source-connection/"
- "/blog/tv-guide-information-missing/"
cta:
  label: "Open Norva support resources"
  href: "https://norva.tv/support"
  intent: "resolve_setup"
sources:
- "https://norva.tv/privacy"
- "https://norva.tv/terms"
- "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "missing"
  type: "first-hand annotated guide-data workflow"
  summary: "Publication requires a controlled authorised guide source, current screenshots, and a documented source-to-player comparison."
  methodology: "A reviewer must record field presence, device time zone, exact labels, one match, and one redacted limitation without exposing private addresses."
  asset_urls: []
---
# How to Add and Check TV Guide Data in Norva

> **In short:** Obtain current guide information from the compatible source you are authorised to use, add it through Norva’s current source or guide controls, and refresh once. Compare one known channel and programme by identity, start and end time, and description. Check device time and time zone before applying any offset.

**Draft verification notice:** the supported guide method, exact controls, and screenshots must be reproduced before publication.

## Guide data is separate from playback

Guide data describes programmes and schedule times. A live item can exist while its guide row is blank, and a schedule entry does not guarantee playback.

Read [TV Guide Data Explained](/blog/tv-guide-data-explained/) before diagnosing matching or timing.

Norva’s privacy policy lists TV-guide URLs among settings a user may choose to add. Treat them as potentially private.

## Prepare a reference

Collect guide information from the source’s official record and confirm permission. Prepare one known channel, one programme with a reliable time reference, the device time zone, and a private results note.

Do not publish the guide address, credentials, or private source identifiers.

## Step 1: verify the underlying source

Confirm that the relevant live entries load before adding guide information. If the source section is empty, schedule setup cannot establish playback.

Use [How to Confirm That a New Source Connected Correctly](/blog/verify-media-source-connection/) to separate base-source and guide outcomes.

**Observable result:** expected live identities appear, even if schedule fields are blank.

## Step 2: open the current guide controls

Follow the live Norva interface to its source or guide settings. Check whether information is already attached before adding anything.

**Observable result:** a current add or edit control is visible.

## Step 3: enter the information privately

Copy the value from its primary source. Inspect it without exposing it, save once, and allow the player to retrieve and interpret the data.

No universal loading time can be promised.

**Observable result:** Norva accepts the setting, starts loading, or shows a specific error.

## Step 4: choose a small window

After a normal refresh, select one known channel and a short time range. Record:

- channel identity;
- programme title;
- start and end;
- description where supplied;
- following item;
- device time zone.

Do not audit the entire schedule first. One controlled example is easier to compare.

## Step 5: compare fields

| Field | Source record | Norva display | Result |
| --- | --- | --- | --- |
| Channel identity |  |  | Match / different / missing |
| Programme title |  |  |  |
| Start and end |  |  |  |
| Description |  |  |  |
| Following item |  |  |  |

Write “missing” instead of inventing a value. Redact identifiers before sharing evidence.

## Diagnose a consistent shift

Confirm device date, local time, and time zone. Determine whether all programmes move by the same amount.

A consistent shift can suggest time interpretation. Random gaps can suggest missing source data or matching problems. Change one documented setting, refresh, and compare the same programme.

Do not apply repeated guessed offsets. Record the date and daylight-saving context.

## Diagnose isolated gaps

If neighbouring channels have data but one does not, compare one working and one failing record. Possible layers include absent guide records, different identifiers, partial retrieval, or an entry from another source.

The planned [missing-guide troubleshooting article](/blog/tv-guide-information-missing/) will expand this branch.

## Confirm the result

A useful initial confirmation has:

- the intended channel matched;
- a plausible current programme;
- times agreeing with the reference and device context;
- following information where supplied;
- no private settings exposed.

This does not certify the complete schedule. Guide data changes and optional fields may be absent.

## Limitations

Norva cannot guarantee completeness or accuracy of source-supplied guide data. The fact baseline does not specify every supported format or menu path, so this draft remains blocked.

Guide accuracy and playback availability are separate.

## Frequently asked questions

### Why is the guide blank while live entries appear?

Retrieval, source coverage, or identifier matching may be incomplete. Compare one source record before changing settings.

### Should I adjust time first?

No. Confirm device time and whether the shift is consistent.

### Can I send the guide address to support?

Use the official route and disclose private values only through a secure process support says is necessary.

## Your next step

[Open Norva support resources](https://norva.tv/support)

## Sources

- [Norva Privacy Policy](https://norva.tv/privacy)
- [Norva Terms of Service](https://norva.tv/terms)
- [Norva support](https://norva.tv/support)

