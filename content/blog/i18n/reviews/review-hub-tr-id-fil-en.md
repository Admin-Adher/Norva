# Independent hub UI review: English, Turkish, Indonesian and Filipino

Reviewer: Codex agent `/root/blog_latin_translations`, independent of the parent-authored English additions and the `/root/blog_asian_translations` Turkish/Indonesian/Filipino translations. Review date: 10 September 2026.

Verdict: approved for this scoped AI-assisted editorial cross-review. No correction is required and no unresolved finding remains. This is not a human or native-speaker certification, a visual-layout acceptance test, or authorization to publish additional content.

## Scope and comparison baseline

Workspace: `C:/Users/AdrienHernandez/.codex/worktrees/norva-blog-i18n-20260910`.

Branch observed: `codex/blog-hub-parity-20260910`.

The four current dictionaries were read in full. All 35 new English `hub*` values and all 105 corresponding Turkish, Indonesian and Filipino values were reviewed for meaning, natural wording, variable placement, control-label clarity, the large-title accent fragment, counting labels, publication-cadence claims and the software-only legal position.

The 40 pre-existing values in each dictionary were compared exactly against `origin/main`, resolved to immutable commit `829d3fcec53c5077726d84d5315e16e0ae1b630d`. Result: 160/160 legacy values unchanged; each current file contains only the same 40 legacy keys plus the 35 new `hub*` keys. This check includes the disclaimer, original-image disclosure, source-publication note and translated-library notice. The reviewer did not edit any of these four reviewed UI files, articles, code, ledger or publication state, and performed no fetch or Git mutation.

Files read:

- `content/blog/i18n/ui/en.json`
- `content/blog/i18n/ui/tr.json`
- `content/blog/i18n/ui/id.json`
- `content/blog/i18n/ui/fil.json`

## Editorial findings

All four new title/accent combinations form a complete, natural heading. Turkish places the accented noun phrase first without splitting a grammatical suffix. Indonesian includes the possessive within its accented phrase. Filipino's existing technical vocabulary, including `media library`, `device`, `pag-play` and `accessibility`, is retained consistently rather than representing an accidental English fallback.

| Locale | Assembled large title | Accented fragment |
|---|---|---|
| EN | A practical operating manual for your media library | media library |
| TR | Medya kitaplığınız için pratik kullanım rehberi | Medya kitaplığınız |
| ID | Panduan praktis untuk pustaka media Anda | pustaka media Anda |
| FIL | Praktikal na gabay para sa iyong media library | media library |

Search, reset, show-more, empty-state, topic and image-alt labels retain the source's intended action or description. `hubCadence` is translated as setup/organisation/playback topics, not a recurring publishing schedule. The future-guide empty state does not invent a date or publication frequency. The topic corresponding to “Watch anywhere” remains a topic label, not a new promise of access, licensing, included media or playback compatibility. The existing software-only, compatible-authorised-source disclaimer is unchanged in all four files.

The initial full reading required no language correction. A subsequent UX update changed only the search examples, as independently rechecked below. The translation author and parent were informed that the reviewed snapshot is ready and that any later text change requires rechecking its fingerprint.

## Structural and interpolation checks

- 75/75 keys present in every file, with exact English key parity.
- Exactly 35 `hub*` additions per file; no legacy key removed or changed.
- All new values are nonempty strings.
- Placeholder multisets match English exactly, including `{accent}`, `{title}` and `{count}`.
- `hubTitle` contains exactly one `{accent}` and combines correctly with `hubTitleAccent`.
- `hubCount`, `hubResults` and `hubRemaining` were each interpolated with 0, 1 and 7 in all four languages. These are deliberately invariant count labels, not grammatically inflected sentences requiring singular/plural branches.
- All automated comparisons passed.

## Search-example delta recheck

After the initial full review, the parent changed the English `hubSearchPlaceholder` from the subtitles/TV/privacy examples to “Norva”, “subtitles” and “resolution”, so that each example finds a card within the seven translated guides. The translation author updated the same field in TR/ID/FIL. This reviewer reread only that delta, checked its meaning and natural wording, and verified every proposed term against the seven local article cards.

The check reproduced the actual `public/js/blog-index.js` search normalization: locale-aware lowercasing, NFD normalization, removal of U+0300–U+036F combining marks, trimming, whitespace tokenization and an `includes` match for every query token. Only each card's title, excerpt and topic-cluster values were used. No hidden article body, URL, image text, date, or common action label was needed to produce a match.

| Locale | Final search placeholder | Matching article IDs for the three terms, respectively |
|---|---|---|
| EN | Try “Norva”, “subtitles”, or “resolution” | 014/015/089; 522; 562 |
| TR | “Norva”, “altyazı” veya “çözünürlük” deneyin | 014/015/089; 522; 562 |
| ID | Coba “Norva”, “subtitel”, atau “resolusi” | 014/015/089; 522; 562 |
| FIL | Subukan ang “Norva”, “subtitle”, o “resolution” | 014/015/089; 522; 562 |

Result: 12/12 example queries find at least one card. Replacing only the new placeholder value with its previous reviewed value reproduces each complete pre-delta UI SHA-256 below, proving that the other 74 fields and file formatting remain unchanged after LF normalization. No placeholder variables, title accents, count labels, legal wording or cadence wording changed in this delta.

| Locale | Pre-delta reviewed 75-key UI SHA-256 |
|---|---|
| EN | `10e8ca4a99c31fbfe012fc3954d1f7572419feaf4aa45a4cb9fc376c02e71968` |
| TR | `534e751c8c4666ec2cbdc77a3cd039b3b8d9498ee7dea7fadfc9edbb98ae983b` |
| ID | `f0adb06697464cc458751a855530c28db0a2dd1a261fe22cf757ce3c2efec9e1` |
| FIL | `143942373227dfbacb77899828ae05bef393747d50d5b95c9ded9e9966c21458` |

The final reviewed fingerprints below supersede those pre-delta UI fingerprints. The verdict remains approved, with no unresolved correction.

## Reviewed new-key inventory

The following complete inventory was read in English and each of TR/ID/FIL:

`hubTitle`, `hubTitleAccent`, `hubDescription`, `hubCount`, `hubCadence`, `hubExplore`, `hubLatest`, `hubReadLatest`, `hubImageAlt`, `hubEmpty`, `hubRecent`, `hubRecentDescription`, `hubLibrary`, `hubLibraryDescription`, `hubSearchLabel`, `hubSearchPlaceholder`, `hubSearchHint`, `hubClear`, `hubClearLabel`, `hubFilterLabel`, `hubAll`, `hubReset`, `hubResults`, `hubRemaining`, `hubNoResults`, `hubNoResultsHint`, `hubBrowseAll`, `hubMore`, `hubFallbackTopic`, `hubStart`, `hubOrganise`, `hubAnywhere`, `hubPlayback`, `hubAccessibility`, `hubPrivacy`.

## Reviewed SHA-256 fingerprints

Hashes cover complete current JSON file text, with CRLF normalized to LF. These four hashes identify the approved review snapshot; no other byte state is implied.

| File | SHA-256, LF-normalized |
|---|---|
| `content/blog/i18n/ui/en.json` | `f76bd921b22a194c15fd5e43f102bd20a854495e45318073917de80b11bc2ad5` |
| `content/blog/i18n/ui/tr.json` | `1fc89f41296d3fa545e9dd79d8c4bb6de4665de193d03de8918371866a1138b2` |
| `content/blog/i18n/ui/id.json` | `25fe9d245bf6588c8083bab9b223ea9a6e75382265db0df93dae98dbbcb8dac3` |
| `content/blog/i18n/ui/fil.json` | `7c90ce129754adb037eb21dec4f5a6bc4d0b9bad547c166ff83f1f79f03179f0` |

For reproducibility, the four baseline JSON fingerprints at the comparison commit are:

| Locale | Baseline SHA-256, LF-normalized |
|---|---|
| EN | `ab14080d6ffb7ba84820d4e72682737d44987fdbabcec358935d97494515870d` |
| TR | `0d68794166a60bf3f1662cb014c07fdcb5395ed555fb92ce469deef55ecf17ca` |
| ID | `19943bb3e6d4a793b4205cbf4bbd8771f534b0aa77e120a33bda5e8b9335996f` |
| FIL | `62e1930eb9bcf7519b4fab9cbaf170dd5a7818bcb1d1636ed582a7c50738c43d` |

The parent owns review-ledger updates, rendered desktop/mobile/RTL acceptance, regression testing and production release. This report claims only the editorial reading and local comparisons described above.
