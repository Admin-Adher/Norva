# Independent hub-copy review: Hindi, Bengali and Arabic

Reviewer: Codex agent `/root/blog_asian_translations`, independent of author `/root/blog_indic_arabic_translations`.

Date: 10 September 2026.

Verdict: pass after the search-placeholder improvements recorded below. No unresolved finding remains in this scoped AI-assisted language review. This is not a human or native-speaker certification, a rendered-layout audit, or production verification.

## Scope and complete reading

Read all 35 new English `hub*` values and all 35 new values in each of Hindi, Bengali and Arabic: 105 translated values compared with the complete 35-key source addition. Rechecked the final changed English search placeholder and all three translated search placeholders after the source was updated to Norva, subtitles and resolution.

Files reviewed:

- `content/blog/i18n/ui/en.json`
- `content/blog/i18n/ui/hi.json`
- `content/blog/i18n/ui/bn.json`
- `content/blog/i18n/ui/ar.json`

All new keys were covered:

- Hero and entry points: `hubTitle`, `hubTitleAccent`, `hubDescription`, `hubCount`, `hubCadence`, `hubExplore`, `hubLatest`, `hubReadLatest`, `hubImageAlt`, `hubEmpty`.
- Recent content, library introduction and search prompt: `hubRecent`, `hubRecentDescription`, `hubLibrary`, `hubLibraryDescription`, `hubSearchLabel`, `hubSearchPlaceholder`, `hubSearchHint`.
- Search and filtering controls: `hubClear`, `hubClearLabel`, `hubFilterLabel`, `hubAll`, `hubReset`, `hubResults`, `hubRemaining`, `hubNoResults`, `hubNoResultsHint`, `hubBrowseAll`, `hubMore`.
- Topic labels: `hubFallbackTopic`, `hubStart`, `hubOrganise`, `hubAnywhere`, `hubPlayback`, `hubAccessibility`, `hubPrivacy`.

The review covered fidelity, naturalness, concise hero wording, accent-fragment composition, search/control meanings, alternative text, exact placeholders and count-label grammar. The 40 pre-existing values in each target file were compared automatically with the local `origin/main` snapshot at `829d3fcec53c5077726d84d5315e16e0ae1b630d`: all 120 values remain exactly equal. No previous disclaimer, original-image disclosure, source/next-step label or article text was edited for this work.

## Language findings and final wording

The three recomposed hero titles are natural and retain the practical-guide meaning:

| Locale | Recombined hero title |
|---|---|
| hi | आपकी मीडिया लाइब्रेरी के लिए व्यावहारिक मार्गदर्शिका |
| bn | আপনার মিডিয়া লাইব্রেরি পরিচালনার ব্যবহারিক নির্দেশিকা |
| ar | دليل عملي لإدارة مكتبة وسائطك |

Each `hubTitle` contains exactly one `{accent}`. The accent value forms part of the same grammatical phrase; no English-only prefix or duplicate title fragment is needed.

The translations retain setup, organisation and playback in `hubCadence`. None promises a daily, weekly, recurring or otherwise scheduled publishing rhythm. The empty-state wording retains only the source's non-scheduled indication of forthcoming guides. Editorial-note wording does not claim a new product test or native-device acceptance.

The source's search/filter distinction and all six topic categories remain clear. Existing technical terms and article terminology are used naturally; Arabic wording remains suitable as textual RTL copy without claiming that its rendered layout was tested here.

## Corrections and source-aligned search improvement

| Finding | Requested change | Final state |
|---|---|---|
| Hindi's original `सबटाइटल` search example is a familiar synonym, but did not appear in the searchable title/excerpt/topic text of the seven translated cards. | Use the article's `उपशीर्षक` term. | Fixed by the author and independently rechecked; it finds article 522. |
| Arabic's original `الترجمة النصية` example did not match the searchable cards, whereas their subtitle terminology uses `الترجمات`. | Use `الترجمات` for the example. | Fixed by the author and independently rechecked; it finds article 522. |
| The parent updated the English source examples to `Try “Norva”, “subtitles”, or “resolution”` so the examples work with the seven-guide selection. | Update only `hubSearchPlaceholder` in all three target files, using the corresponding local article terms. | Fixed by the author. The final Hindi, Bengali and Arabic examples all have positive card matches. |

No other semantic, grammatical, placeholder or cadence finding remains. The reviewer did not edit any Hindi, Bengali or Arabic UI file; changes were requested from their author and reported to the parent.

## Search-example verification

Verified the nine final target-language search examples independently using the same lowercasing, NFD normalization, U+0300–U+036F mark removal, whitespace tokenization and all-token substring matching as `public/js/blog-index.js`.

The test searched only article title, excerpt and translated topic-cluster metadata, all visible in the cards rendered by `scripts/blog/lib/templates.js`. Article bodies were not included. It did not add unrelated topic labels or hidden keywords to manufacture matches.

| Locale | Example | Matching article IDs |
|---|---|---|
| hi | Norva | 014, 015, 089 |
| hi | उपशीर्षक | 522 |
| hi | रिज़ॉल्यूशन | 562 |
| bn | Norva | 014, 015, 089 |
| bn | সাবটাইটেল | 522 |
| bn | রেজল্যুশন | 562 |
| ar | Norva | 014, 015, 089 |
| ar | الترجمات | 522 |
| ar | الدقة | 562 |

The seven card-source filenames checked under each of `content/blog/translations/hi/`, `content/blog/translations/bn/` and `content/blog/translations/ar/` were:

- `014-norva-getting-started.md`
- `015-connect-compatible-media-source-norva.md`
- `027-organize-large-movie-collection.md`
- `089-what-is-norva-media-player.md`
- `522-captions-and-subtitles-why-the-accessibility-goals-can-differ.md`
- `542-legibility-and-readability-two-different-viewing-problems.md`
- `562-resolution-and-bitrate-why-they-are-not-the-same.md`

This is a local content/search-model check, not a browser interaction test or a search-indexation claim.

## Final automated checks

- All three target dictionaries pass `loadUi`: 75 keys each, comprising 40 unchanged keys and exactly 35 new `hub*` keys.
- Exact placeholder multisets match English for every new key. In particular, `{accent}`, `{title}` and `{count}` remain intact with no duplicate or missing occurrence.
- `hubCount`, `hubResults` and `hubRemaining` were recomposed for 0, 1 and 7 using `Intl.NumberFormat(locale)`. Their invariant label constructions remain acceptable for zero, one and larger counts. Bengali localized digits were included in the check.
- All 120 pre-existing target-language values are unchanged versus the recorded `origin/main` commit.
- All nine final search examples produce at least one match using visible card metadata only.
- Complete-file SHA-256 values below use CRLF-to-LF normalization, including all old and new keys.

## Reviewed byte fingerprints

| File | SHA-256 with LF normalization |
|---|---|
| content/blog/i18n/ui/en.json | `f76bd921b22a194c15fd5e43f102bd20a854495e45318073917de80b11bc2ad5` |
| content/blog/i18n/ui/hi.json | `5e0de4dd0714fe527ee3a2943b151f142ebec8a3d8523d2492d0cde0f5dccbbe` |
| content/blog/i18n/ui/bn.json | `87daece9ed5ed6a161061b750df9a7ff99a2a775aaf18de1e7871d6dfc2b8f59` |
| content/blog/i18n/ui/ar.json | `f26f92b2193a737bf1707a012392c63d4d2bf39937893f9e0e55e33aa153f86e` |

The verdict applies to these exact final file snapshots. Any later text change must be reported before inheriting this review. No code, article, review ledger, publication state or Git ref was changed by this reviewer. The parent owns the separate rendering tests, release validation, production deployment and live verification.
