---
content_id: "NVB-255"
title: "How to Read Series and Episode Details in a Live Guide"
seo_title: "Read Series and Episode Details in a Live Guide"
meta_description: "Read live episode metadata with a hierarchy card separating series, season, episode, version, schedule event, service, and confidence without guesswork."
slug: "read-episode-data-in-live-guide"
canonical_url: "https://norva.tv/blog/read-episode-data-in-live-guide/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "how-to"
topic_cluster: "Live Guide Literacy"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "How should series and episode details be read in a live guide?"
supporting_questions:
  - "How does an episode identity differ from its scheduled event?"
  - "What should be done when season or episode data is incomplete?"
audience:
  - "Viewers identifying a series episode from guide data"
  - "Norva users comparing recurring listings"
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
excerpt: "A live-episode hierarchy card protects the difference between the underlying episode and one scheduled occurrence of it."
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
  - "/blog/recognize-recurring-programs/"
  - "/blog/channel-vs-program-metadata/"
  - "/blog/spot-stale-program-descriptions/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "awareness"
sources:
  - "https://www.eidr.org/how-we-work"
  - "https://dvb.org/metadata/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "live-episode hierarchy card"
  summary: "The card records series, season, episode, version, program identity, schedule event, service, timing, source, and confidence as separate layers."
  methodology: "Readers identify the schedule occurrence, trace its program hierarchy, preserve raw numbering, compare multiple fields, and leave incomplete episode data unknown."
  asset_urls: []
---

# How to Read Series and Episode Details in a Live Guide

> **In short:** Read from the scheduled occurrence inward: service and time, program event, underlying series, season, episode, and version. Preserve raw titles and numbers, and compare several fields before matching an episode. A listing can correctly identify a series while omitting or mislabeling the particular episode.

Live guides often have less room and less complete metadata than a series detail page. The visible title may represent the series, episode, edition, or generic slot. A hierarchy card prevents one field from being promoted into an unsupported identity.

## Fill in the live-episode hierarchy card

| Layer | Observed value | Identifier | Confidence |
|---|---|---|---|
| Service |  |  |  |
| Schedule event |  |  |  |
| Program or series |  |  |  |
| Season |  |  |  |
| Episode |  |  |  |
| Version or edition |  |  |  |
| Start and duration |  |  |  |
| Source refresh |  |  |  |

Do not collapse blank season and episode rows into zero or “episode one.”

## Start with the schedule occurrence

Confirm the exact service, full start timestamp, duration, zone, and event identifier. This identifies one listing occurrence. Use [the channel-versus-program distinction](/blog/channel-vs-program-metadata/) so the service name or logo is not mistaken for series metadata.

A repeated airing should normally create a distinct schedule occurrence even when the underlying episode identity is the same.

## Trace the program hierarchy

Look for:

- canonical series title and alternate title;
- season number or named season;
- episode number;
- episode title;
- original date or edition date;
- stable identifiers;
- version, language, or regional attributes.

EIDR’s public hierarchy distinguishes Series → Season → Episode → Edit → Manifestation. A guide may expose only some layers, but the conceptual separation prevents a series title from being treated as an episode identifier.

## Preserve raw numbering

Keep labels such as “S2 E4,” “Episode 14,” “Part 2,” or a named special exactly as supplied. Add a normalized interpretation in a separate field only when evidence supports it. Production order, broadcast order, and platform order can differ.

Do not derive an episode number from the number of previous guide occurrences.

## Match with several fields

Use the strongest combination available:

1. stable episode identifier;
2. series and season parentage;
3. episode number and title;
4. original or edition date;
5. synopsis, duration, and cast as supporting evidence.

Artwork similarity is weak evidence. If the title and synopsis conflict, use [the stale-description diagnostic](/blog/spot-stale-program-descriptions/) before choosing one.

## Distinguish recurrence and repeats

A recurring series title does not say whether the event is a new edition, a different episode, or a repeat. Apply [the recurring-program fingerprint](/blog/recognize-recurring-programs/) and look for explicit repeat evidence or matching content identifiers.

## Handle missing fields

Use labels such as:

- series confirmed, episode unknown;
- episode title supplied, season unknown;
- episode identity probable, version unknown;
- generic series block with no episode detail.

This is more useful than filling gaps from neighboring events. Missing metadata can be reported to the source or support with service, event, time, and refresh context.

DVB metadata work covers program information, but actual field completeness depends on the source feed.

## Check display and accessibility

Episode title, season, and number should remain distinguishable on TV, mobile, and web. Truncation must not hide the only differentiating suffix. A details action can reveal more, but focus should not trigger spoilers without warning.

On the narrowest guide view, verify that two adjacent episodes with similar titles can still be distinguished before opening details.

Norva can display live and series metadata from compatible sources a user is authorized to access. The source determines which hierarchy fields and versions are available; current product presentation should be verified.

## Common mistakes and limitations

- Treating the series title as episode identity.
- Deriving episode order from schedule occurrence count.
- Filling missing season data from memory.
- Matching by artwork or duration alone.
- Calling every repeated title a rerun.
- Ignoring source refresh and service variant.

## Frequently asked questions

### Is an episode title enough to identify the item?

Not always. Titles can repeat or be localized. Combine parent series, season, number, date, and identifiers.

### What if the guide shows only the series name?

Report the episode as unknown. Do not infer it from the usual schedule.

### Can the same episode have multiple schedule events?

Yes. Keep the underlying episode identity separate from each service and time occurrence.

## Your next step

[Explore Norva Features](https://norva.tv/#features)

## Sources

- [EIDR: How We Work](https://www.eidr.org/how-we-work)
- [DVB Metadata](https://dvb.org/metadata/)
- [Norva Features](https://norva.tv/#features)
