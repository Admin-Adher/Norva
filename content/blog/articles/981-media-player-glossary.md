---
content_id: "NVB-981"
title: "The Complete Glossary of Media Player Terms"
seo_title: "Complete Glossary of Media Player Terms"
meta_description: "Learn media-player terms for sources, catalogs, playback state, synchronization, formats, buffering, security, subscriptions, devices, and offline use."
slug: "media-player-glossary"
canonical_url: "https://norva.tv/blog/media-player-glossary/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "media-player-concept-glossary"
topic_cluster: "Media Player Glossary & Concepts"
search_intent: "informational"
funnel_stage: "awareness"
primary_question: "Which terms help users understand a modern media player?"
supporting_questions:
  - "How do catalog, playback, synchronization, format, device, security, and subscription terms relate?"
  - "Which similarly named concepts should not be treated as interchangeable?"
audience:
  - "Media player users"
  - "Norva users reading setup and support guidance"
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
  source_of_truth: "https://norva.tv/#how-it-works"
published_at: null
updated_at: null
last_fact_check: null
estimated_reading_minutes: 8
excerpt: "A practical glossary separates the media, catalog, playback, synchronization, format, storage, security, device, and subscription concepts users encounter."
hero: { src: "", alt: "", width: 1600, height: 900 }
og_image: ""
schema_type: "BlogPosting"
faq_schema: { enabled: false }
is_pillar: true
parent_pillar: null
related_articles:
  - "/blog/playback-position-vs-completion-state/"
  - "/blog/media-source-vs-media-catalog/"
  - "/blog/playback-pipeline-source-to-screen/"
cta:
  label: "See How Norva Works"
  href: "https://norva.tv/#how-it-works"
  intent: "awareness"
sources:
  - "https://norva.tv/#how-it-works"
  - "https://html.spec.whatwg.org/multipage/media.html"
  - "https://www.w3.org/TR/media-capabilities/"
  - "https://www.rfc-editor.org/rfc/rfc9110"
  - "https://pages.nist.gov/800-63-4/sp800-63b.html"
proof_assets: []
original_evidence:
  required: true
  status: "present"
  type: "media-player concept map"
  summary: "A layered map places twenty-five terms into source, catalog, playback state, format, delivery, device, security, subscription, and offline boundaries."
  methodology: "Terms are defined by their operational role, contrasted with the nearest confusing concept, and connected from source to screen without claiming that every player implements every capability."
  asset_urls: []
---

# The Complete Glossary of Media Player Terms

> **In short:** A media player sits between an authorized media source and a screen. It may organize a catalog, decode supported formats, maintain playback state, and coordinate viewing context across supported devices. Terms such as source, catalog, container, codec, buffer, cache, profile, account, authentication, authorization, entitlement, and receipt describe different parts of that system.

This glossary provides operational definitions, not promises that every player supports every feature. Norva is a media player and organizer; users connect a compatible source they own or are legally authorized to use. A Norva subscription does not include a media catalog.

## Source and catalog terms

**Media source:** The authorized system or location that supplies media and related information to the player.

**Media catalog:** The organized representation users browse. It can include titles, artwork, hierarchy, variants, and source-derived metadata without being the media source itself. See [media source versus media catalog](/blog/media-source-vs-media-catalog/).

**Catalog import:** An initial or requested process that reads source information into the player's organized view.

**Catalog synchronization:** An ongoing or repeated process that reconciles later source changes with that view.

**Metadata:** Descriptive or structural information such as title, year, season, episode, language, or technical properties. Incomplete metadata can limit organization.

**Grouped version:** A presentation that places records believed to represent versions of the same work together while preserving their differences.

**Duplicate item:** An additional record that may be redundant, but similarity alone does not prove duplication.

## Playback-state terms

**Playback position:** A point on a media timeline, often represented as elapsed time.

**Completion state:** A classification such as not started, in progress, or completed, usually derived from more than a raw position. The [position and completion guide](/blog/playback-position-vs-completion-state/) explains the boundary.

**Resume point:** A saved position intended to continue playback.

**Bookmark:** A user- or system-created reference to an item or moment that may exist independently of current playback progress.

**Favorite:** A saved preference that marks an item for later discovery. It does not establish media availability.

**History:** A record of viewing-related events or state. Its exact contents and controls depend on the service.

**Sync conflict:** Two or more competing state changes that cannot all become the final value without a resolution rule.

## Media-format terms

**Container:** A file or stream structure that holds tracks and metadata. Common containers can carry different encoded audio, video, or text formats.

**Codec:** A defined method for encoding and decoding media information.

**Decoder:** The software or hardware component that turns encoded data into video, audio, or another renderable form.

**Track:** One component of media, such as video, an audio language, or subtitles. A preference cannot create a track absent from the source media.

**Bitrate:** The amount of data processed or delivered per unit of time. It influences, but does not alone determine, quality or file size.

## Delivery and storage terms

**Playback pipeline:** The chain from source selection through delivery, parsing, decoding, synchronization, rendering, and output. See the [source-to-screen pipeline](/blog/playback-pipeline-source-to-screen/).

**Buffer:** Short-term data held to smooth immediate playback when delivery timing varies.

**Cache:** Reusable stored data intended to avoid repeating work or retrieval. Its lifetime and contents can be broader than a playback buffer.

**Offline availability:** A supported state in which selected authorized media can be used without a current network connection, subject to device, source, media, rights, storage, and product conditions.

**Local file:** A file present in device storage. Its presence alone does not prove that a player may open it offline or that rights and entitlement conditions are satisfied.

## Identity and device terms

**Account:** The service-level identity and administrative relationship that can include sign-in, billing, devices, sources, and household configuration.

**Profile:** A viewing context inside an account, often used for progress, favorites, preferences, or recommendations. It is not necessarily a separate security identity.

**Trusted device:** A device relationship recognized by an account according to the service's current controls.

**Signed-in session:** A current authenticated service session. A device may have multiple sessions, and a recognized device label is not proof that every session is safe.

**Pairing code:** Usually a short-lived value used to connect a device during a specific ceremony. It should be protected and not stored.

**Device token:** A machine-held credential or identifier used after an authorized relationship is established. It should not be displayed or handled like a temporary code.

## Security and subscription terms

**Authentication:** Establishing or verifying the identity of an account, user, or device.

**Authorization:** Determining what an authenticated identity is permitted to do. Authentication does not create rights to third-party media.

**Encryption in transit:** Protection applied while data moves between endpoints under a defined protocol and scope.

**Encrypted storage:** Protection applied to stored data under specified key and device conditions.

**Subscription entitlement:** The service-side state that determines access to paid capabilities under current plan and account conditions.

**Payment receipt:** Evidence that a payment transaction occurred. It may help support investigate billing, but it is not itself the live entitlement record.

## Original evidence: concept map

| Layer | Input | Key concepts | Output |
| --- | --- | --- | --- |
| Source | Authorized media and metadata | Source, track, rights | Available records |
| Catalog | Source-derived records | Import, sync, grouping, metadata | Browsable organization |
| Playback | Selected media | Container, codec, decoder, buffer | Rendered audio and video |
| State | Viewer actions | Position, completion, resume, favorite | Viewing context |
| Account | Identity and plan | Authentication, authorization, entitlement | Permitted service actions |
| Device | Session and storage | Pairing, token, cache, offline state | Screen-specific experience |

## Frequently asked questions

### Are these terms implemented identically by every player?

No. The concepts are broadly useful, but names, controls, thresholds, and capabilities differ. Check current official product guidance.

### Does a catalog contain the media itself?

Not necessarily. A catalog is the organized representation; the source supplies the media and available metadata.

### Does authentication prove media rights?

No. Authentication verifies an identity or session. Authorization and legal rights are separate questions.

## Your next step

[See How Norva Works](https://norva.tv/#how-it-works)

## Sources

- [How Norva works](https://norva.tv/#how-it-works)
- [WHATWG HTML media elements](https://html.spec.whatwg.org/multipage/media.html)
- [W3C Media Capabilities](https://www.w3.org/TR/media-capabilities/)
- [RFC 9110 HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110)
- [NIST digital identity guidance](https://pages.nist.gov/800-63-4/sp800-63b.html)
