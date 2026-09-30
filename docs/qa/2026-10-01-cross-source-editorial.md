# Verified text for grouped titles across sources

## Real failure

Selection's `Un golpe de altura` fiche renders Spanish audio correctly after
the publication repair, but displays no synopsis and its untranslated provider
title. This persists after a reload on the founder's authenticated session.
The ordinary QA and founder title records, and the global validated TMDB 59108
record, contain a French synopsis (177 characters). The actual visibility-fenced
hydration RPC also returns that metadata in overlay_catalog_metadata.

The founder's grouped title has eight active variants across three sources.
Its selected display generation belongs to Xtream; the Selection variant has
a different active generation. The flat-media editorial hydrator rejects that
otherwise valid association because it is a generation projection.

## Correction

Retain exact user, media, source, item type, current generation, unique variant
and visibility-epoch checks. For a multi-source grouped title only, permit the
verified TMDB **title and synopsis** to reach another owned active version.
The payload must have eligible match status, explicit validation=true and an
exact matching positive TMDB ID. Prefer the requested translation, then the
validated default. Copy those text fields into both flat and TMDB client shapes.

Do not pass this cross-generation projection into the language/generation
binder. Do not copy its audio maps, provider metadata, runtime, artwork, routing,
identifiers or playback facts. Generic cross-generation progressive payloads,
single-source contradictions, stale visibility, foreign or ambiguous variants,
unvalidated metadata and mismatched TMDB IDs remain rejected. The existing full
catalogue overlay flag is unchanged.

## Verification status

26 focused tests pass across editorial metadata, synopsis overlays, exact-file
codec overlays and audio generation fences. Coverage includes film and series
default-language fallback and explicit preservation of file facts.
Production deployment and refreshed browser/ordinary-QA evidence remain pending.
