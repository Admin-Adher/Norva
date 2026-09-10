# Independent translation review: French, Spanish and Brazilian Portuguese

Reviewer: Codex agent `/root/blog_indic_arabic_translations`, independent of the author `/root/blog_latin_translations`. This is an AI-assisted editorial cross-review, not a human or native-speaker certification. The user-authorized exception for this batch and the release decision are recorded separately by the parent agent.

Review date: 10 September 2026.

Status: complete. All 21 French, Spanish and Brazilian Portuguese articles and all three UI dictionaries were read in full. The author applied the corrections below; the reviewer independently checked the changed wording in the final files. No unresolved editorial blocker was found in this scoped review. The reviewed translations still have `translation_status: "in_review"`; approval stamping and publication belong to the parent agent.

## Method and source material

All seven English source articles were read in full, including metadata, and compared with every substantive translated section, original example, table, qualification, FAQ, link and call to action. The review checked grammar, natural phrasing, localized terminology, title and metadata accuracy, and compatibility with the unchanged English screenshots and illustrations.

Special attention was given to the product boundary (software player and organiser, no supplied catalogue or included media access), source ownership or authorisation, compatibility conditions, conditional offline access, profile counts, and the distinction between observed catalogue behaviour and unvalidated playback, native-device or cross-device acceptance. Translation does not turn illustrative examples into product measurements.

The editorial and factual references read were `AGENTS.md`, `content/blog/README.md`, `content/blog/README.source.md`, `content/blog/EDITORIAL-GUIDE.md`, `content/blog/FACT-CHECK-GUIDE.md` and `content/blog/PRODUCT-EVIDENCE-20260909.md`. This review checks faithful translation of the recorded source evidence. It is not a fresh product test, an independent determination of source rights, or a live verification of cited external websites.

English source articles read in full:

- `content/blog/articles/014-norva-getting-started.md`
- `content/blog/articles/015-connect-compatible-media-source-norva.md`
- `content/blog/articles/027-organize-large-movie-collection.md`
- `content/blog/articles/089-what-is-norva-media-player.md`
- `content/blog/articles/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/articles/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/articles/562-resolution-and-bitrate-why-they-are-not-the-same.md`

The parent's `splitDocument`, `checkStructure`, `hashText` and `loadUi` functions were used for automated verification. The final check covered identical heading-level sequences, link destinations, original image paths and order, list-item and table-row counts, normalized source SHA-256, locale/source identity, localized source/next-step headings in metadata and body, H1/title agreement, review status and method, UI keys and placeholders. Structural agreement supports but does not replace semantic reading.

## Exact files read in full

- `content/blog/translations/fr/014-norva-getting-started.md`
- `content/blog/translations/fr/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/fr/027-organize-large-movie-collection.md`
- `content/blog/translations/fr/089-what-is-norva-media-player.md`
- `content/blog/translations/fr/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/fr/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/fr/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/i18n/ui/fr.json`
- `content/blog/translations/es/014-norva-getting-started.md`
- `content/blog/translations/es/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/es/027-organize-large-movie-collection.md`
- `content/blog/translations/es/089-what-is-norva-media-player.md`
- `content/blog/translations/es/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/es/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/es/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/i18n/ui/es.json`
- `content/blog/translations/pt-BR/014-norva-getting-started.md`
- `content/blog/translations/pt-BR/015-connect-compatible-media-source-norva.md`
- `content/blog/translations/pt-BR/027-organize-large-movie-collection.md`
- `content/blog/translations/pt-BR/089-what-is-norva-media-player.md`
- `content/blog/translations/pt-BR/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `content/blog/translations/pt-BR/542-legibility-and-readability-two-different-viewing-problems.md`
- `content/blog/translations/pt-BR/562-resolution-and-bitrate-why-they-are-not-the-same.md`
- `content/blog/i18n/ui/pt-BR.json`

## Concrete corrections requested and verified

| File or group | Issue before correction | Applied solution and final check |
|---|---|---|
| French 027 | The construction `Sélectionnez une Audio language utile` treated an English UI label as a French noun phrase. | The step now says `Sélectionnez une langue pertinente dans **Audio language**.`, keeping the exact visible control label. Verified in the final file. |
| French 542 | `pas une gagnante mesurée` was an unnatural literal rendering of the qualification that the layout is not a measured winner. | The paragraph now calls it `une piste d’amélioration, pas une solution dont la supériorité a été mesurée`. The no-measured-superiority qualification is explicit. Verified. |
| French 522 | The translated fictional dialogue ended with a duplicate full stop after `« Attends ici. »`. | The duplicate punctuation was removed; the dialogue and later door-knock sequence remain unchanged. Verified. |
| Spanish 014 | `No intentes completar una prueba de compatibilidad` could discourage completing any compatibility test, rather than attempting a comprehensive test in the short first session. | The sentence now says `No intentes realizar una prueba completa de compatibilidad.`, restoring the scope of “complete”. Verified. |
| Spanish 027, filter step | `Selecciona un Audio language útil` used the English control label as a Spanish noun phrase. | The step now says `Selecciona un idioma útil en **Audio language**.` Verified. |
| Spanish 027, grouping | `nuevas versiones de películas` for remakes could be confused with technical versions of the same film, the very distinction this section protects. | The list now explicitly uses `remakes`, alongside sequels and same-name works. Verified. |
| Spanish 027, fictional exercise | The negation before the deletion example could be read ambiguously when not repeated after the comma. | The exercise now explicitly says `no borra un registro por un campo vacío`, retaining the keep-and-investigate safeguard. Verified. |
| Spanish 089, excerpt and FAQ | The authorisation clause did not clearly identify the user as the person legally permitted to use the source. | Both passages now say `que este está legalmente autorizado a usar`. The legal subject is explicit and no rights are implied by the subscription. Both occurrences verified. |
| Spanish 089, evaluation | `lo que pasó` meant what happened rather than which checks passed. | The link paragraph now says `qué pruebas se superaron`. Verified. |
| Spanish 542 | `no una ganadora medida` was an unnatural literal rendering of the evidence limitation. | The paragraph now says `no una solución cuya superioridad se haya demostrado con mediciones`. Verified. |
| Brazilian Portuguese 027, introduction | `A medida útil é encontrar` did not naturally express findability as the useful criterion. | The introduction now says `O critério útil é a facilidade de encontrar o que você procura`. The original viewing question follows unchanged. Verified. |
| Brazilian Portuguese 027, filter step | `Selecione um Audio language útil` used the English control label as a Portuguese noun phrase. | The step now says `Selecione um idioma útil em **Audio language**.` Verified. |
| Brazilian Portuguese 089, evaluation | `registrar o que passou` was ambiguous between what happened and what passed. | The paragraph now says `registrar quais testes foram aprovados`, alongside items requiring rechecking or not applicable. Verified. |
| Brazilian Portuguese 542 | `não um vencedor medido` was an unnatural literal rendering of the limitation on the candidate layout. | The paragraph now says `não uma solução cuja superioridade tenha sido demonstrada por medições`. Verified. |
| Brazilian Portuguese 522 and 562 | `reprodutor de software` could read as a player of software rather than media-player software. | Both product-boundary passages now say `software de reprodução de mídia`; the no-catalogue and authorised-source conditions remain intact. Both files verified. |
| Brazilian Portuguese 522, fictional scene | The English illustration dialogue `“Wait here.”` was followed by a duplicate full stop. | The duplicate punctuation was removed without changing the original label, translated explanation or sequential sound cue. Verified. |

The reviewer did not edit any French, Spanish or Brazilian Portuguese translation or UI dictionary. Findings were sent to their author, with progress and resolution reported to the parent, preserving exclusive file ownership.

## Findings from full readings

French 7/7: no missing substantive content, altered factual number or expanded product claim was found. The captions/subtitles distinction is explained through accessible subtitling and dialogue subtitling rather than represented as a universal technical boundary. The bitrate example uses appropriate French numerical and byte-unit conventions with the same decimal calculation and explicit relation to the unchanged English image.

Spanish 7/7: the source setup sequence, metadata-versus-playback distinctions, authorisation safeguards and private-data exclusions are preserved. The corrected remake terminology and explicit negative deletion instruction keep the fictional collection exercise unambiguous. All FAQs and original examples remain complete.

Brazilian Portuguese 7/7: the five-step first-session plan, optional access-period path, source-filter/search observations, later favourite persistence, source ownership and unvalidated playback boundaries remain intact. The three explanatory articles retain the caption information goal and cue sequence, recognition-versus-reading-task distinction, and independent resolution/bitrate concepts with their limitations.

Across all three languages, the date of the recorded web observation remains 10 September 2026. The five first-session checkpoints, twelve displayed versions, optional five-step to three-step path, two versus five profiles, five caption scenes, and five fictional catalogue records representing four distinct works are preserved. The arithmetic example retains 1920 × 1080, 2,073,600 pixels, assumed 4/8 Mbps, 600 seconds, 300/600 decimal MB and eight bits per byte. Its average-rate assumption, exclusions for audio, subtitles, container/encryption/network overhead, and absence of a quality or connection-speed guarantee remain explicit.

UI 3/3: all 40 values in each dictionary were read, for 120 translated values. Navigation, headings, language selection, byline and article labels remain clear. The media-provider disclaimer preserves the software-only and authorised-source boundary. `originalImages` explains that the screenshots and illustrated examples remain in English and were not altered to imply a fresh product test. `{minutes}`, `{date}` and `{count}` are preserved. The library notice uses the dynamic `{count}` rather than a fixed seven.

## Final verification and verdict

After the last Portuguese corrections, all 21 articles passed the structural, source-hash, identity, H1, localized-heading, status and method checks. All three UI dictionaries passed the 40-key and placeholder checks. SHA-256 fingerprints below identify the complete reviewed files with CRLF normalized to LF.

Verdict: approved for this scoped AI-assisted editorial cross-review under the user-authorized batch exception, with no unresolved editorial finding. This is not a native-speaker or human certification, accessibility-conformance certification, source-licensing determination, playback acceptance, publication confirmation or live-deployment verification.

No translation status, Git ref or publication state was changed by this reviewer. The parent owns final review records, the status-only release stamp, validation and publication. Any later prose or UI change requires a new review or an explicit review addendum; a mechanical `in_review` to `approved` stamp will change the full-file hash and must be recorded separately.

## Reviewed byte fingerprints

Paths are relative to the repository root. These values identify the reviewed `in_review` snapshot, not a later release-stamped version.

| File | SHA-256, CRLF normalized to LF |
|---|---|
| `content/blog/translations/fr/014-norva-getting-started.md` | `31670e6b79299c2f1cff793a04f6dd6bbd4d166261ecd3c1a30925454bce6070` |
| `content/blog/translations/fr/015-connect-compatible-media-source-norva.md` | `36eb521c5064ca3adf46eddb0a7a4705e07b016b1d4a1913f1fa5e853144d564` |
| `content/blog/translations/fr/027-organize-large-movie-collection.md` | `5e8776190af7174c8484e0b4bdef2c83aaa7d689fdb0ad4bc5beaea5d4cd7677` |
| `content/blog/translations/fr/089-what-is-norva-media-player.md` | `e0591a5dee44b6672c4503402cdf44850de17d330f0ae087304f638eab7c3d8e` |
| `content/blog/translations/fr/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md` | `2a3d3067a4f46993aa7eeb48a807304bef7f67ea307887839ce34e51be4f8c1c` |
| `content/blog/translations/fr/542-legibility-and-readability-two-different-viewing-problems.md` | `409d3a190ad7df36c9ae0908dab532cd6394a7a39e2e232d603291bd76a23f5d` |
| `content/blog/translations/fr/562-resolution-and-bitrate-why-they-are-not-the-same.md` | `36e03e7170100d2085b268dd6caf27d3b2f5dafb75f0f2b928ad9496091e1739` |
| `content/blog/i18n/ui/fr.json` | `bb85d9981a9aa44baa570ae0abdf72a29da4c40599d39650613d250390216a63` |
| `content/blog/translations/es/014-norva-getting-started.md` | `0903692521f9d7950e5e8618166f359cafb3bd0ffdac5dc1bc65731c64b9bb5c` |
| `content/blog/translations/es/015-connect-compatible-media-source-norva.md` | `b4741350eecf55071e2f40179f897c5c2899c5f27d23f2f32952d20dbd164fc3` |
| `content/blog/translations/es/027-organize-large-movie-collection.md` | `c34e28ffe397c4cd5d23db551e50f20a5dfa332d9de53aafa7f8a87375fb6cf4` |
| `content/blog/translations/es/089-what-is-norva-media-player.md` | `f0c101e34326f181d523a1fbfe70e8174dada1769c441e854823cd18b5dbe012` |
| `content/blog/translations/es/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md` | `5aaa4f79e991d789fda41b06795f6d0d14f3c701a3f6fa7b7ee5c14845f60f1f` |
| `content/blog/translations/es/542-legibility-and-readability-two-different-viewing-problems.md` | `d13ce384d6096c32c32371f4fd5c45628a8b81884afe5065b3190576a15cb745` |
| `content/blog/translations/es/562-resolution-and-bitrate-why-they-are-not-the-same.md` | `bb1898fcf793a46e0bb9cd57545f32d061bd04c7af76d9c3a50d51ae314c9e93` |
| `content/blog/i18n/ui/es.json` | `6b40d2e6094207ac58178182494ca8820309e03c145c2dadbf18f8f74811df3a` |
| `content/blog/translations/pt-BR/014-norva-getting-started.md` | `4256163c92580a4e50b43411b9dd4fd5eee94a1e71968bd45b46d36752339cd6` |
| `content/blog/translations/pt-BR/015-connect-compatible-media-source-norva.md` | `0cb05b1c8a0dcbbbc7cdab0f39ad3786838d82e504ea60318063eea7e0ba3485` |
| `content/blog/translations/pt-BR/027-organize-large-movie-collection.md` | `3ed9df9a41d97c6b75a26a7180ebd119ca0eee25a1a599f33681a523569cf4cc` |
| `content/blog/translations/pt-BR/089-what-is-norva-media-player.md` | `5bce88b0f338115eb72984861bd8f73650305d5b7120ead1b4e40f4f3b80d925` |
| `content/blog/translations/pt-BR/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md` | `b05b697aecc6cc0b97c6c070e4e5f640060764d1e6a47b7eb005d6016de5b947` |
| `content/blog/translations/pt-BR/542-legibility-and-readability-two-different-viewing-problems.md` | `46be8ff918306742ef0d924c478c14babd76389d0de6a63f72b1edaad84edc09` |
| `content/blog/translations/pt-BR/562-resolution-and-bitrate-why-they-are-not-the-same.md` | `b2b76b380ef03e00b283cb3f746529c2da0148a3a18223abaf8a01e4d59e687d` |
| `content/blog/i18n/ui/pt-BR.json` | `45601256d3750fb05fd5ba56f668393b1c27bd0d6d7924f04f341b7137abd4b9` |

## Source byte fingerprints

These are the complete English source files used for the comparison, with the same LF normalization.

| File | SHA-256, CRLF normalized to LF |
|---|---|
| `content/blog/articles/014-norva-getting-started.md` | `f49a10b2880f3cc4a8fa82c203ac9042a99bd85bab4ec846d308e37889f63b69` |
| `content/blog/articles/015-connect-compatible-media-source-norva.md` | `8efa2f6c3971568d3ed277e8cdd99305ea755c0d2b3628b40aefe9cc0d3bf659` |
| `content/blog/articles/027-organize-large-movie-collection.md` | `70d3f683f1bcc47dc17c14e181cb0a1b72a5e687ae129f5eb370c0fd9c3dc8ce` |
| `content/blog/articles/089-what-is-norva-media-player.md` | `82eee2f74722ec16664a26e811d7ea18a4fc9b2dc90733bb8fe49d56af804297` |
| `content/blog/articles/522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md` | `8609ed90fdc87c761863c6237160c53b74df1b4dca9ccad442b2fcba69fdde81` |
| `content/blog/articles/542-legibility-and-readability-two-different-viewing-problems.md` | `1b55217a33e5761ed80d94c9865abae96810f3ab7ef102102082a65f06d9dd9b` |
| `content/blog/articles/562-resolution-and-bitrate-why-they-are-not-the-same.md` | `f01136e764e04cac55c20c14d3c6d393d827a51ecc5bf37cce8da07de71596be` |

