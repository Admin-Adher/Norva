# Norva Selection: series and editorial metadata

Selection classifies explicit numbered season markers (`Season 1`, `Season 2 Part 1`, `S01E03`) at import time. The word “Season” alone does not identify a series. Films such as *Happiest Season* keep their movie type.

The importer groups each series by feed, base title and language category. A season file's year is not used as the parent series' first-air year. The parent is browsable under Series; the original physical files are stored as children. Their existing playback IDs remain unchanged, including for older movie history links.

A file can contain a whole season, several seasons or a part. The UI displays the supplied season/part coordinates and does not invent individual episode links or copy TMDB episode durations onto bundles. Playback obtains the actual HLS duration. Individual episode metadata overlays remain available for normal Xtream series.

Selection series details and playback require the authenticated owner's canonical Selection source, a visible catalogue generation and the corresponding parent/file relationship. They reuse the approved VOD feed resolver and URL allowlist. They do not enter the Xtream exact-episode registry.

TMDB search policy `catalog-title-tags-v3` removes release-quality/language suffixes, preserves lexical parentheticals, distinguishes a numeric title from its release year, and continues locale search after a weak candidate. Automatic acceptance still requires confidence >= 0.9 and a compatible year. Uncertain identities and absent TMDB synopses remain unconfirmed.

Existing catalogues use the normal admin resync/finalize workflow. The bounded service-only `norva_requeue_catalog_search_for_source` RPC can recover unmatched searches after the policy update without resetting the global worker cursor or overwriting validated titles. New imports enter the existing automatic owner/enrichment workflow.

Supplier language categories are declarations for badges/facets, not evidence of observed audio tracks. This provenance remains internal; real playback track observations retain priority.
