---
content_id: "NVB-258"
title: "How to Spot a Program Description That May Be Stale"
seo_title: "Spot a Program Description That May Be Stale"
meta_description: "Detect stale guide descriptions with a field-level fingerprint comparing event identity, episode data, dates, revisions, neighboring fields, and source freshness."
slug: "spot-stale-program-descriptions"
canonical_url: "https://norva.tv/blog/spot-stale-program-descriptions/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can a stale program description be identified?"
supporting_questions:
  - "Which conflicts are useful warning signals?"
  - "How can stale text be distinguished from a valid repeat?"
audience:
  - "Viewers who notice conflicting guide descriptions"
  - "Norva users preparing a metadata report"
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
excerpt: "A description fingerprint isolates stale text without treating every repeated synopsis or generic summary as an error."
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
parent_pillar: "/blog/live-program-guide-literacy/"
related_articles:
  - "/blog/read-episode-data-in-live-guide/"
  - "/blog/recognize-recurring-programs/"
  - "/blog/document-guide-data-problem/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://dvb.org/metadata/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "program-description field fingerprint"
  summary: "The fingerprint compares description text with event, program, episode, date, duration, version, revision, neighboring occurrences, and source freshness."
  methodology: "Readers preserve raw text, verify the target event, compare independent fields, test repeat and generic-summary explanations, and label stale only when stronger current evidence conflicts."
  asset_urls: []
---

# How to Spot a Program Description That May Be Stale

> **In short:** Preserve the raw description, verify the exact service event, and compare it with episode identity, edition date, duration, identifiers, revision time, and neighboring occurrences. Repeated text is a warning signal, not proof of staleness. Call a description stale only when stronger current evidence shows that it belongs to another event or an older version.

Descriptions often update on a different schedule from start times and titles. A source may reuse a generic series summary intentionally, while a stale cache may attach yesterday’s episode synopsis to today’s event. Field-level comparison distinguishes the cases.

## Build the description fingerprint

| Field | Observation |
|---|---|
| Service and event identifiers |  |
| Raw title |  |
| Raw description |  |
| Series, season, episode or edition |  |
| Start, duration, and zone |  |
| Version or regional label |  |
| Event revision time |  |
| Client retrieval time |  |
| Previous and next descriptions |  |
| Conflict and confidence |  |

Do not edit the raw text inside the evidence card.

## Confirm the event before judging the text

Use [the live episode hierarchy card](/blog/read-episode-data-in-live-guide/) to establish series, episode, schedule occurrence, and service. A description can be accurate for one regional version and wrong for another.

If the event itself is ambiguous, report “description cannot be matched confidently” rather than stale.

## Look for independent conflicts

Useful warning signals include:

- a named episode in the description conflicts with episode fields;
- the synopsis mentions an edition date different from the event;
- the text is identical across events whose stable episode identifiers differ;
- a description references people or topics tied to an older verified edition;
- title and duration updated while the description revision remained old;
- another current authoritative source supplies a different synopsis for the same identifier.

No single signal is conclusive. Generic series summaries are often intentionally reused.

## Test the repeat explanation

The same description may be correct when the same episode is scheduled again. Apply [the recurring-program fingerprint](/blog/recognize-recurring-programs/) and compare episode or content identifiers. A new schedule event does not necessarily mean new underlying content.

## Separate timing freshness from text freshness

A guide can show a current start time with an old synopsis. Record revision or retrieval evidence for each field where available. DCMI metadata terms distinguish title, description, identifier, date, relation, and temporal concepts; one current field does not validate all the others.

## Classify the result

- **Current and specific:** description aligns with verified event identity.
- **Current but generic:** description intentionally covers the broader program or series.
- **Possibly stale:** several fields conflict, but no definitive replacement text exists.
- **Stale with evidence:** the description maps to a different or superseded identified event.
- **Unknown:** event or revision evidence is insufficient.

Preserve “possibly” and “unknown” when appropriate.

## Compare devices and source responses

Capture the same event identifier on another supported device. If one description updates after a refresh, note both retrieval times. If every device receives the same conflicting text, the issue is more likely upstream than a single local rendering state.

Treat a description change without an event-identifier change as evidence of field refresh, not proof that the entire schedule was corrected.

DVB metadata work covers program information, but source completeness and synchronization vary.

## Report the smallest problem

Use [the guide support bundle](/blog/document-guide-data-problem/) and say “description mismatch” rather than “schedule wrong” when start and event identity remain correct. Include safe identifiers, exact raw text, timestamps, zone, and expected evidence. Remove unrelated personal data.

Norva displays metadata from compatible sources a user is authorized to access. The source provides descriptions; current support can help distinguish product display behavior from upstream content.

## Common mistakes and limitations

- Declaring every repeated synopsis stale.
- Comparing different regional service events.
- Rewriting raw evidence before reporting.
- Assuming a current title validates the description.
- Matching by artwork alone.
- Reporting a text issue as a playback failure.

## Frequently asked questions

### Is a generic series summary an error?

Not necessarily. Label it generic when it accurately describes the program but not the specific episode.

### Can an old description coexist with correct timing?

Yes. Metadata fields and caches may update independently.

### Should I supply a corrected synopsis?

Only cite authoritative current evidence. Do not invent editorial text from memory.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DVB Metadata](https://dvb.org/metadata/)
- [DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva Support](https://norva.tv/support)
