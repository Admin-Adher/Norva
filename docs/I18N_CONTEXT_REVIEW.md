# Contextual UI translation review — 8 September 2026

## Scope and findings

The review starts from the actual French title-rating buttons (`Comme` / `Pas pour moi`).
An inventory of 947 short UI strings from the catalogue, Home, settings and player was
examined to identify ambiguous source words and untranslated user-facing copy. The
identified contexts were reviewed across English, French, Brazilian Portuguese,
Spanish, Hindi, Turkish, Bengali, Arabic, Indonesian and Filipino.

109 existing Web message keys received corrections (100 contextual entries, two
Filipino playback labels and seven final catalogue/Arabic context refinements), with corresponding existing native messages updated where
the source context matches. The generated catalogue completeness check covers all
7,216 shared/Web entries and 3,240 native resource entries. **Completeness is a structural
check, not a claim that every sentence has received a native-speaker linguistic review.**

Examples of corrected meanings:

| Context | Incorrect interpretation | Intended meaning |
| --- | --- | --- |
| Thumbs up / down | Comparison (`Comme`, `जैसे`, `مثل`) | Personal preference: like / dislike |
| Specials | Commercial offers in several locales | Special episodes outside normal seasons |
| Watch status | A clock or surveillance | Viewing progress |
| Director / cast | Company director or a verb | Film direction and actors |
| Release period | Release from confinement | Film/series release date |
| Save data | Save a file or record | Reduce mobile data usage |
| Back to live | Return to life | Return to the live broadcast |
| Subtitle background | Context / background information | Background behind the subtitle text |
| Track / time left | Railway / left direction | Audio track / remaining duration |

## Runtime fixes

- Render catalogue badges, audio/subtitle facets and player language names in the
  chosen UI language. Use language codes, not English labels returned by the server.
- Format facet counts with the UI locale, retaining IDs, source scope and selections.
  A compact `language · count` avoids English nouns and incorrect singular forms.
- Translate the catalogue/language/display filter headings and curated genre names;
  keep provider-defined category names intact when their IDs are not in the taxonomy.
- Keep selected rating tooltips and accessibility actions in sync with translation
  metadata, including after a language change. Rating persistence is unchanged.
- Use plural rules for season counts, including Arabic forms.

## Rules for future copy

1. Identify whether a word is an action, status, genre, technical value or proper name.
   Never translate `Like` or `Specials` without the rating/episode context.
2. Reuse `i18n/glossary.json` for reviewed whole UI phrases. Apply contextual Web
   overrides in `i18n/reviewed.json`. `Cast` in title credits is deliberately excluded
   from the general glossary because casting to a television has another meaning.
3. The draft translator's context helper disambiguates exact phrases. It must not
   rewrite arbitrary provider titles, URLs, brands, filter values or user data.
4. Preserve interpolation parameters. Supply a numeric `count` for plural messages;
   check one, two and multiple items, especially in Arabic.
5. Run `npm run i18n:build`, `npm run i18n:check` and the contextual language tests.
   Generated HTML asset references must change with their bundles.

## Acceptance evidence

- 82 focused Node tests passed, including rating transitions, language facets,
  catalogue filter scope, taxonomy parity, track labels and generated resources.
- 60 Web scenarios passed: 10 locales × films/series × 360×800, 844×390 and 1280×800.
- The offline fixture uses actual `app.html`, CSS, rating control, catalogue page
  methods and mobile filter setup. Its rating API is a local stub; no user preference
  or provider stream is changed during acceptance.
- `ContextualLanguageInstrumentedTest` repeats the actual fixture in Android WebView
  at 100% and 130% text zoom in portrait and landscape. Production and device run
  results are recorded separately from source/build checks in the delivery report.

Browser plugin was absent; rendered Web verification used the installed CUA browser
with DOM/CDP measurements and screenshot inspection. No machine translation service
was called for this review.
