---
content_id: "NVB-244"
title: "How to Judge Whether Program Guide Data Is Current"
seo_title: "Judge Whether Program Guide Data Is Current"
meta_description: "Audit guide freshness with retrieval time, coverage horizon, boundary transitions, source state, and comparison controls instead of trusting a recent-looking title."
slug: "check-program-guide-freshness"
canonical_url: "https://norva.tv/blog/check-program-guide-freshness/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "retention"
primary_question: "How can someone judge whether program guide data is current?"
supporting_questions:
  - "Which freshness signals are stronger than a familiar program title?"
  - "How should partial or stale coverage be reported?"
audience:
  - "Viewers troubleshooting old or stuck guide data"
  - "Norva users checking schedule update quality"
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
excerpt: "A guide freshness ledger separates when data was retrieved, how far it covers, whether boundaries transition, and what the source currently reports."
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
  - "/blog/read-now-and-next-guide/"
  - "/blog/interpret-blank-schedule-blocks/"
  - "/blog/interpret-overlapping-listings/"
cta:
  label: "Visit Norva Support"
  href: "https://norva.tv/support"
  intent: "retention"
sources:
  - "https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf"
  - "https://www.w3.org/WAI/tutorials/forms/notifications/"
  - "https://norva.tv/support"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "program-guide freshness ledger"
  summary: "The ledger combines retrieval timestamp, publication or update evidence, coverage horizon, transition checks, source state, and comparison controls."
  methodology: "Readers capture a baseline, observe a scheduled boundary, compare a known control service, classify scope, refresh once, and report current, stale, partial, conflicting, or unknown."
  asset_urls: []
---

# How to Judge Whether Program Guide Data Is Current

> **In short:** Check when the guide was retrieved, how far its schedule extends, whether a recent event boundary transitioned correctly, and whether the source still returns newer data. Compare a known control service and record the affected scope. A title that looks plausible is not proof of freshness; recurring schedules can make stale data look current.

Freshness describes whether displayed guide data reflects the latest usable schedule available from its source. It is different from correctness: newly fetched data can contain a bad title, while older data may coincidentally remain accurate.

## Build the guide freshness ledger

| Signal | Observation | Time checked | Scope | Confidence |
|---|---|---|---|---|
| Last retrieval or refresh |  |  | App / source / service |  |
| Coverage start |  |  |  |  |
| Coverage horizon |  |  |  |  |
| Last boundary transition |  |  |  |  |
| Source response |  |  |  |  |
| Control service |  |  |  |  |
| Device comparison |  |  |  |  |

Use exact timestamps and zones. “Updated recently” cannot be audited.

## Separate five freshness signals

### Retrieval time

When did the client last request or receive guide data? A recent request does not guarantee a changed response, but an old retrieval is a clear warning.

### Coverage horizon

How far into the future does the schedule extend? A guide may be fresh for the current hour but incomplete for tomorrow. Record both start and end coverage.

### Boundary transition

Did the scheduled next event become current at its boundary? Use [the now-and-next checksum](/blog/read-now-and-next-guide/) and note whether the transition occurred without a manual reload.

### Source state

Does the compatible source currently return a schedule, an error, partial data, or no data for that service? Source availability and client cache state are separate.

### Comparison control

Choose another service or device known to update reliably. If only one row is stale, the scope differs from an entire guide failure.

## Run a controlled freshness test

1. Record current time and zone.
2. Capture the current and next event identities and boundaries.
3. Wait for the next natural boundary while keeping the test short.
4. Observe whether labels and progress update.
5. Perform one documented refresh.
6. Compare source response and a control row.
7. Reopen the guide on another supported device if needed.

Do not repeatedly refresh without recording outcomes; that can erase the evidence needed to distinguish cache, source, and display problems.

## Classify the result

- **Current:** coverage includes now, the recent transition is correct, and no newer source state is known.
- **Stale:** the display remains on superseded data despite a newer verified response.
- **Partial:** some services or time ranges update while others do not.
- **Conflicting:** devices or source layers disagree and the cause is unresolved.
- **Unknown:** timestamps or comparison evidence are insufficient.

The DVB-I specification distinguishes published schedule timing and optional actual timing. A late operational update may legitimately change what “latest” means, so record which timing fields are present.

## Diagnose by scope

If one service is affected, inspect its identifier, regional variant, and schedule feed. If every service on one device is affected, inspect clock, connectivity, cache, and refresh behavior. If all devices show the same old horizon, investigate the source rather than clearing every local state.

For gaps after an otherwise current window, use [the blank-schedule evidence ladder](/blog/interpret-blank-schedule-blocks/). For duplicated or conflicting intervals, use [the overlap diagnostic](/blog/interpret-overlapping-listings/).

## Communicate the status clearly

W3C notification guidance favors clear status and recovery. Report “Guide coverage ended at 22:00; refresh returned no later events for this service” rather than “Guide broken.” Include source, service, device, zone, and check time.

Norva can display guide information supplied by compatible sources a user is authorized to access. The source controls schedule coverage and update quality; Norva support can help interpret product behavior, but no interface can invent authoritative events absent from the feed.

## Avoid destructive troubleshooting

Preserve a screenshot or small ledger before clearing caches or reconnecting sources. Change one factor at a time. Do not reset unrelated progress, favorites, or library data to solve a schedule-only symptom.

## Common mistakes and limitations

- Equating a recent fetch with correct current data.
- Using a recurring title as freshness proof.
- Ignoring the schedule coverage horizon.
- Refreshing repeatedly without a baseline.
- Treating one stale service as a system-wide failure.
- Reporting “live” without a timestamp and zone.

## Frequently asked questions

### How recent must guide data be?

There is no universal age threshold. It must cover the relevant time and reflect available updates for the intended service.

### Can a guide be partly current?

Yes. Coverage can vary by service, date range, metadata field, or device cache.

### Does a correct progress bar prove freshness?

No. It may be calculated from old boundaries that happen to align with the current clock.

## Your next step

[Visit Norva Support](https://norva.tv/support)

## Sources

- [DVB-I Specification](https://dvb.org/resources/public/standards/a177_dvb-i_specification.pdf)
- [W3C: User Notification](https://www.w3.org/WAI/tutorials/forms/notifications/)
- [Norva Support](https://norva.tv/support)
