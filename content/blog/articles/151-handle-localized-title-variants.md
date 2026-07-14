---
content_id: "NVB-151"
title: "How to Handle Localized and Original Title Variants"
seo_title: "Handle Localized and Original Media Titles"
meta_description: "Handle original, translated, localized, transliterated, and alternate media titles with explicit roles, language tags, provenance, aliases, and search tests."
slug: "handle-localized-title-variants"
canonical_url: "https://norva.tv/blog/handle-localized-title-variants/"
language: "en"
status: "draft"
robots: "noindex,nofollow"
content_type: "practical-how-to"
topic_cluster: "Metadata Quality"
search_intent: "informational"
funnel_stage: "consideration"
primary_question: "How should original and localised title variants be handled?"
supporting_questions:
  - "How can title role, language, script, and territory be kept distinct?"
  - "Which title should be displayed and which should remain searchable?"
audience:
  - "People maintaining multilingual media catalogues"
  - "Households searching by original and translated titles"
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
excerpt: "A multilingual title record should preserve each known form with an explicit role, language, script, territory, provenance, and display or search purpose."
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
parent_pillar: "/blog/media-metadata-quality-audit/"
related_articles:
  - "/blog/search-alternate-media-titles/"
  - "/blog/search-original-and-translated-titles/"
  - "/blog/normalize-media-title-capitalization/"
cta:
  label: "Explore Norva Features"
  href: "https://norva.tv/#features"
  intent: "consideration"
sources:
  - "https://www.w3.org/International/articles/language-tags/"
  - "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/"
  - "https://norva.tv/#features"
proof_assets: []
original_evidence:
  required: true
  status: "included"
  type: "title-variant role ledger"
  summary: "A ledger records every title form with role, language, script, territory, work identity, provenance, display eligibility, and search-alias status."
  methodology: "Readers inventory title variants, validate identity and tags, apply a household display policy, preserve aliases, and test retrieval using each verified form."
  asset_urls: []
---

# How to Handle Localized and Original Title Variants

> **In short:** Keep each verified title form as a distinct claim rather than overwriting one with another. Record whether it is original, translated, localised, transliterated, alternative, or edition-specific; add language, script, territory, provenance, and work identity. Choose one display title through a documented household policy, but retain other valid forms as searchable aliases where supported.

A title can change across languages, scripts, territories, releases, and editions. Those differences help people recognise a work, yet poorly labelled variants can also merge unrelated titles or hide the name a household remembers.

## Distinguish the title roles

Use precise roles:

- **Original title:** the title associated with the work’s original release context.
- **Translated title:** a title expressed in another language.
- **Localised title:** a market-facing form adapted for a particular territory or audience.
- **Transliterated title:** the original-language title represented in another writing system.
- **Alternate title:** another verified name for the same work whose relationship is known.
- **Edition title:** wording that distinguishes a cut, restoration, or release and should not be treated as a general alias.

One string can fit more than one description, but the stored role should explain why it exists. Do not call a transliteration a translation merely because both use Latin characters.

## Build the title-variant role ledger

Create one row per title form:

| Work ID | Title form | Role | Language tag | Script/territory | Source | Display? | Search alias? | Confidence |
|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |

The W3C explains that language tags can express language, script, and region where those distinctions are known. Use only verified subtags. A source’s country does not prove the title’s language or intended territory.

Dublin Core distinguishes title and alternative title. That simple separation is useful: a display title and an alternate access point can coexist without competing for one field.

## Confirm work identity before adding aliases

Compare stable source identifiers, creators, release year, runtime, synopsis, and edition. Similar strings in different languages do not prove that two records represent the same work.

When identity is uncertain, keep the title candidate in review. An incorrect alias can make search appear more complete while returning the wrong film or series.

## Choose a display policy

A household policy might prefer:

1. a verified title in the profile’s language;
2. otherwise the original title;
3. otherwise the connected source’s title with provenance;
4. a secondary original or transliterated form on the details page when useful.

This is a policy, not a universal rule. Some households prioritise original titles; others need familiar local release titles. Avoid changing the display title solely according to device language unless that behaviour is intentional and tested.

Protect official capitalisation, diacritics, punctuation, and script. Use [the capitalisation workflow](/blog/normalize-media-title-capitalization/) before normalising a large batch.

## Preserve search access without visual clutter

Where supported, keep verified non-display forms as search aliases. Test [alternate-title search](/blog/search-alternate-media-titles/) and [original-versus-translated search](/blog/search-original-and-translated-titles/) using exact, partial, and familiar household forms.

Do not expose every alias on every card. A details view can show the primary title plus one useful original or localised form, while search uses a broader verified set behind the interface.

## Pilot across difficult examples

Choose titles with different scripts, territory-specific names, remakes, numbered instalments, punctuation, and edition wording. After a supported mapping change:

1. refresh the catalogue normally;
2. search each verified variant;
3. distinguish remakes and editions;
4. inspect web, mobile, and TV layouts where supported;
5. confirm grouped versions retain the same work identity;
6. check that source refresh does not recreate a conflicting primary title;
7. retain rollback and the original ledger.

Norva can organise metadata from compatible authorised sources, but the title forms supplied and alias controls available may depend on those sources.

## Common mistakes and limitations

- Replacing the original title with an unlabelled translation.
- Removing diacritics to make search easier.
- Treating transliteration as a translated meaning.
- Adding aliases from memory without identity evidence.
- Mixing edition wording into the work’s universal title.
- Assuming every source uses the same territorial title.

Some historical or market-specific titles remain disputed. Preserve provenance and uncertainty rather than inventing a single definitive form.

## Frequently asked questions

### Should the original title always be visible?

Not necessarily on every card. It should remain identifiable in metadata or details when verified, while the display policy can prioritise the title most useful to the profile.

### Can two translations both be valid?

Yes. Different territories or releases may use different verified translations. Label their scope and retain both as access points where supported.

### What if an alias matches another work’s main title?

Search must then present enough disambiguating context—such as year, creator, type, or artwork. Do not delete a valid alias merely because results require careful distinction.

## Your next step

[Explore Norva's features](https://norva.tv/#features)

## Sources

- [W3C: Language tags in HTML and XML](https://www.w3.org/International/articles/language-tags/)
- [Dublin Core: DCMI Metadata Terms](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/)
- [Norva features](https://norva.tv/#features)
