# Qualified VOD expansion — 7 September 2026

This expansion corrects the sample-only import. Representative playback qualifies a media service; the importer can retain more files from that service after bounded access and metadata checks. It does not claim continuous playback of every retained video.

## Catalogue scope

Immutable public GitHub snapshots:

- HERBERTM3/iptv, commit `db68a796bafdfe0a198bdf141e68335b0250d2c2`, `peliculas MP4.m3u`.
- JuanEstebanGaleano/KlysmGt, commit `895d690f2899a2eca22f97738f0db486a6980c1c`, three playlist files; only the previously sampled Oracle bucket qualifies.
- s4f1ixcustom/L00000, commit `c1034ed9eaec5d161afaecc3cde54345f9d3dcb5`, all 28 `filmes/` playlists; only the sampled Sandro movie service qualifies.

Of 2,445 distinct candidate URLs, 2,386 returned a recognizable video header. Complete-season checks, held files, three CAM copies and already imported anchors narrow the addition to 2,316 new files: 2,094 movie versions and 222 episodes. Four new series parents bring the database addition to 2,320 rows. Sixteen existing anchor/parent rows retain their identity and metadata.

No arbitrary file on these hosts becomes resolvable. Exact URL pins, canonical Selection ownership and the existing generation fences remain. The VOD identity revision stays `selection-vod-20260906-v1`: it is a resolver compatibility contract, not an audit timestamp.

## Complete seasons

| Series | Complete seasons | Episodes |
|---|---|---:|
| Suits | 2–6 | 80 |
| Peaky Blinders | 1–6 | 36 |
| Prison Break | 1–3 | 57 |
| Game of Thrones | 1–2 | 20 |
| Spartacus | 1–2 | 23 |
| Jesus of Nazareth | 1 | 4 |
| Trump: An American Dream | 1 | 4 |

These 20 seasons contain 224 distinct episode files, two of which were existing anchors. The existing Prison Break S04E21 anchor remains separately available. Provider chapter numbers were normalized against current TMDB episode counts; this is an inventory check, not an audiovisual fingerprint of every episode.

Suits S1 repeats one URL for episodes 11 and 12. Prison Break S4 lacks a separately identified episode 22. Spartacus S3 has nine of ten episodes; its prequel is a separate specials inventory and is held. Chernobyl has one unavailable episode. Ambiguous season bundles stay excluded. The movie `Chernobyl O Filme` is independent and remains eligible.

## Tags and provenance

All playlist entries in the addition were inspected. None declares audio or subtitle languages. Alphabetical groups, franchises, and the title `Dual` must not become language or genre tags. The original title/group/file path remain internal audit metadata. Editorial genres and synopses continue through Norva's existing TMDB enrichment workflow.

A bounded ffprobe metadata read succeeded on 2,155 of the 2,316 new files. The other 161 files keep unknown tags. The checks read container metadata, not complete playback. Ordered audio/subtitle streams, codecs, dimensions and duration are retained per file; multiple languages are not collapsed to one. Cropped HD/FHD dimensions are handled, and SD remains eligible. Missing/undefined/unknown language codes never inherit a playlist country, title language or TMDB original_language.

In ISO 639-2, `lat` denotes Latin and `ice` denotes Icelandic. In this snapshot those unusual tags are held independently per track until speech evidence supports a correction. A bounded two-window speech check may correct a label but does not create a strict Whisper-verification certificate. Original tags, candidates, confidence, and pending review remain internal.

Movie projection seeds the existing exact-file cache and fenced language observations for each canonical Selection source. The cache remains source-scoped; no provider identity is invented. A cached probe is not overwritten by a later import, and an interrupted fanout can resume. Episode details return the exact file's snapshot tracks and never promote an episode's ordered stream indices onto the parent series.

The existing sample audit, authenticated playback protocol and unresolved distribution-rights status remain documented in `selection-tested-vod-20260907.md`. Sampling and metadata reads do not establish perpetual availability, Android/TV acceptance, or concurrent-user capacity.
