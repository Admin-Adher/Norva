---
content_id: "NVB-655"
title: "Playback Errors After a Source Refresh: Check Identity First"
seo_title: "Playback Errors After Source Refresh: Check Identity"
meta_description: "After refreshing a source, compare source identity, title and version mapping, tracks, duplicates, session, timestamp, device scope, exact errors, and rollback."
slug: "playback-errors-after-a-source-refresh-check-identity-first"
canonical_url: "https://norva.tv/blog/playback-errors-after-a-source-refresh-check-identity-first/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "source-refresh-error-diagnostic"
topic_cluster: "Playback Error Diagnostics"
search_intent: "playback errors after source refresh"
funnel_stage: "retention"
primary_question: "What identity checks matter after playback errors follow a source refresh?"
supporting_questions: []
audience: []
author:
  name: ""
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
  source_of_truth: "https://norva.tv/; https://norva.tv/support; https://norva.tv/privacy; https://norva.tv/terms"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 4
excerpt: "Verify the refreshed authorised source, title edition, duration, version identity, tracks, duplicates, and availability before changing network or device settings. Record refresh time, exact error, prior and current mapping, session state, and device scope. A refresh can reveal changed source data without proving that refresh logic failed."
hero:
  src: ""
  alt: ""
  width: 1600
  height: 900
og_image: ""
schema_type: "BlogPosting"
faq_schema:
  enabled: false
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "pre-refresh and post-refresh source identity map"
  summary: "A map records authorised source identity, refresh time, title and version IDs, edition, duration, tracks, duplicates, availability, session, device scope, exact error, prior mapping, recovery, and unknowns."
  methodology: "Follow the article's visible workflow, record observable results, and compare only the stated variables before drawing a conclusion."
  asset_urls: []
is_pillar: false
parent_pillar: "/blog/how-to-read-a-playback-error-before-trying-a-fix/"
related_articles:
  - "/blog/one-version-fails-while-another-plays-compare-safely/"
  - "/blog/media-unavailable-separate-temporary-and-persistent-cases/"
  - "/blog/how-to-create-a-support-ready-playback-error-report/"
cta:
  label: "Explore Norva's Playback Features"
  href: "https://norva.tv/#features"
  intent: "retention"
sources:
  - "https://www.rfc-editor.org/rfc/rfc9110"
  - "https://www.rfc-editor.org/rfc/rfc6973"
  - "https://norva.tv/privacy"
---
# Playback Errors After a Source Refresh: Check Identity First

> **In short:** Verify the refreshed authorised source, title edition, duration, version identity, tracks, duplicates, and availability before changing network or device settings. Record refresh time, exact error, prior and current mapping, session state, and device scope. A refresh can reveal changed source data without proving that refresh logic failed.

Source refresh is a metadata and identity boundary. The poster or title can remain familiar while the selected version changes.

## Define the refresh action

Record manual or automatic refresh, app and device versions, start and completion time, source category, visible warnings, and whether the action was interrupted. Do not repeat refresh continuously.

Never share source credentials, tokens, or full endpoints.

## Verify source identity

Confirm the user owns or is authorised to access the source. Record an abstract source label, account-safe state, and official connection status. If several sources have similar names, distinguish them privately without exposing addresses.

Norva organises compatible authorised sources; it does not provide their media catalogue.

## Match entries before and after

Compare title, edition, duration, year, version grouping, language, quality, audio and subtitle tracks, and stable identifiers when safely exposed. Mark missing prior data unknown.

[Compare one failing version safely](/blog/one-version-fails-while-another-plays-compare-safely/) when mapping changed.

## Original evidence: identity map

| Field | Before refresh | After refresh | Verified difference |
|---|---|---|---|
| Source identity/status | Context | Context | Change |
| Title/edition/duration | Values | Values | Change |
| Version/tracks/group | Values | Values | Change |
| Duplicate/availability | Context | Context | Change |
| Session/device scope | Context | Context | Change |
| Error/phase/recovery | Result | Verbatim | Pattern |

Store stable IDs privately and redact them from public reports.

## Check duplicates and grouping

A refresh can add, remove, or regroup entries according to source data and player behavior. Verify whether the selected card now points to another version. Do not delete duplicates until identity and playback are documented.

Another poster or metadata match is not proof of identical media.

## Preserve refresh timing and completion

Record whether the refresh completed, timed out, was interrupted, or continued in the background. Wait only for the documented completion state before testing playback. Compare an entry known before refresh with one newly discovered afterward and note whether their identifiers, durations, and tracks are stable across a second normal refresh. Do not repeatedly refresh until the list looks expected; that can hide transient source state and make the first error impossible to reconstruct. A completed indicator is evidence about the refresh operation, not proof that every entry is playable.

## Separate unavailable from error

If the entry disappears or becomes unavailable, [separate temporary and persistent cases](/blog/media-unavailable-separate-temporary-and-persistent-cases/). If it remains but returns an exact code, preserve phase and wording.

RFC 9110 provides HTTP semantics, but user-facing messages must not be mapped to a status without validated evidence.

## Compare scope

Test another title from the same authorised source, the same title on another supported device, and another source entry without changing session and network together. If all refreshed entries fail, source/session scope gains relevance. If one device alone fails, local cache or client state becomes a hypothesis, not proof.

Keep the prior path and time window as stable as practical.

## Use narrow recovery

Wait for a documented refresh interval, reselect the verified entry, restart only the app after evidence capture, and follow official source or Norva support. Do not remove and re-add the source until credentials, grouping, history, and rollback consequences are understood.

Avoid factory resets and broad network changes.

## Prepare a private report

[Create a support-ready playback error report](/blog/how-to-create-a-support-ready-playback-error-report/) with abstract source, refresh timeline, identity differential, exact code, devices, comparisons, and recovery. RFC 6973 and Norva privacy information support minimizing disclosure.

Current Norva refresh behavior and supported source fields require verification from official documentation.

## Frequently asked questions

### Does refresh replace the media itself?

It may update how source-provided entries are represented; exact behavior depends on source and app and must be verified.

### Should duplicates be deleted immediately?

No. They may preserve different source versions; document identity and grouping first.

### Does re-adding the source prove a cache problem if it works?

No. It changes identity, session, metadata, and state together, so the exact cause remains unknown.

## Your next step

[Explore Norva's playback features](https://norva.tv/#features)

## Sources

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [RFC 6973: Privacy Considerations](https://www.rfc-editor.org/rfc/rfc6973)
- [Norva Privacy](https://norva.tv/privacy)