# Multilingual blog — reviewed selections

The first selection contains seven reviewed English articles and nine complete
translations of each article: 70 article versions, **not 70 different topics**.
The remaining English library is not automatically translated or retired.

The second authorized batch adds ten other individually revised English sources
and ninety full translations: 100 additional versions, for a cumulative
**seventeen topics and 170 selected versions**. The explicit cumulative inventory
is `translations/selection.json`; it locks each source's original slug and
first-publication instant. See `RELEASE-BATCH2-20260910.md` for selection evidence,
scope and limitations. Counts here describe the selected families, not the entire
English archive or a promise of indexed URLs.

## Locale and URL contract

Use the application's registry in `i18n/locales.json`: English, French,
Brazilian Portuguese, Spanish, Hindi, Turkish, Bengali, Arabic, Indonesian and
Filipino. These are languages, not ten country campaigns.

- Existing English URLs stay `/blog/<source-slug>/`; `/blog/` remains the complete English library.
- A translated article is `/blog/<locale>/<source-slug>/`; each locale has its own `/blog/<locale>/` hub.
- The source slug is the permanent document identity. Translating prose never changes an established URL.
- Every released version has a self-canonical and the same reciprocal HTML hreflang set, including itself and English `x-default`.
- `fil` remains the application, route, and HTML BCP 47 code. The Search annotation uses ISO 639-1 `tl`, matching Norva's existing `tl → fil` language-policy alias. No unsupported `fil-PH` country targeting is invented.
- The entire article and navigation are authored in the URL's language. There is no browser-language/IP redirect. The app runtime respects the static document marker only on blog paths.
- Reading a guide does not change a stored app preference. An explicit onward product link uses the existing locale API to carry the article language into the application. If storage is unavailable, the link still works.
- Related articles are localized only when that translation exists. English-only links are visibly labelled. The original English heading IDs remain stable so existing deep links work between versions.
- Arabic is right-to-left. Product labels needed to match original English screenshots stay in English, with a translated explanation.

## Sources and evidence

Translations live in `content/blog/translations/<locale>/` with the same filename
as their English source. The `source_sha256` is the SHA-256 of the complete source
Markdown normalized from CRLF to LF. All destinations, images, heading levels,
list entries and table rows must survive translation. Structural parity is a
regression check, **not a substitute for reading the prose**.

The nine existing proof assets are reused unchanged. Alt text, captions and
explanations are localized. A visible disclosure identifies the English original
images. A translation is not a new product test, a human review, or native-device
acceptance. Unverified playback, M3U, native/offline and immediate-favourite
behaviour remain explicitly qualified. Norva remains a player for an authorised
compatible personal source, without a supplied media catalogue.

## Review and release gates

For this first 63-translation lot, Adrien explicitly authorized **double review
by agents instead of an identified human review**, and production after validation
(10 September 2026). This is a scoped exception to the English corpus guide, not
a claim of human or native-speaker certification and not permission to release
future automated drafts. Original English frontmatter review claims are not
changed or fabricated.

The same scoped exception was explicitly confirmed for the second 100-version
batch on 10 September 2026: “Oui, même processus et mise en production”. This
includes the ten revised English sources as well as ninety translations. It does
not approve future batches or waive any technical/source verification gate.

1. Translator reads the whole source, translates the whole body and metadata,
   and self-reviews. Files remain `translation_status: "in_review"`.
2. A different agent reads source and translation, checks meaning, qualifications,
   numbers, grammar, UI labels, link and illustration references. Findings are
   corrected and recorded; the final bytes receive `translation_status: "approved"`.
3. `translations/reviewed.json` records final source and translation hashes,
   `method: "ai_assisted_cross_review"`, decisions, reviewer task identifiers,
   and the explicit owner release authorization. No human reviewer is invented.
4. Run local previews and tests. Preview pages are `noindex,nofollow`, absent from
   the production sitemap and hreflang sets. Do not deploy preview output.
5. Only an explicit `--publish-translations` build can enter a new approved
   translation into its separate `translations/published-state.json`. The actual
   first release timestamp is stored, never copied from the older English article.
   The visible original-publication note retains the source's date.
6. Normal scheduled builds render only recorded releases. They never approve new
   translations. A changed source or changed reviewed bytes fail closed until
   a new matching review/release. A reviewed update retains first publication.
7. Verify public responses, canonical/hreflang, rendered content and app links
   after deployment. Record search indexation separately; deployment does not
   prove discovery, indexing, ranking, traffic or commercial conversions.

Normal release builds reject any leftover unpublished HTML or hub under a locale
directory. They do not silently delete previews. Use a clean release checkout, or
complete the explicit reviewed release before deploying. CI rebuilds recorded
releases, rejects an artifact diff, validates every release hash and rejects
unpublished extra pages or any remaining `noindex` locale output.
Translated UI dictionaries and their English reference also require matching
review hashes: a changed disclaimer or navigation cannot bypass article review.
Use Node 22.22.3, matching CI, for release rendering and its ICU date formatting.

Commands from a clean isolated worktree:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run i18n:build
node scripts/blog/build-blog.js --existing-only --preview-translations
node scripts/blog/preview-server.js 4181
node --test tests/blog-localization.test.js tests/blog-editorial-rendering.test.js tests/blog-measurement-contract.test.js tests/ui-language.test.js
# Only after independent review, hash recording and owner authorization:
node scripts/blog/build-blog.js --existing-only --publish-translations
npm run i18n:check
npm test
```

Do not use the scheduled default build to silently add newly due English articles
as part of this maintenance release. Preserve existing calendar/publication state.

## Measurement and extension

GA4 blog diagnostics add bounded `article_language`; the existing same-tab,
consent-gated 30-minute CTA context adds `blog_article_language` to actual funnel
events only. No new key event, Ads conversion, spend, or Meta action is configured.
Register/report those GA4 event-scoped dimensions separately if needed; receiving
a parameter does not automatically make it an available custom report dimension.

Track each explicit selection batch separately from new English articles. Compare
queries, country, device and comparable time windows before expanding. Translate
the next article only after its own editorial improvement and source review.

Primary reference:
[Google Search Central: localized versions](https://developers.google.com/search/docs/specialty/international/localized-versions)
(reciprocity, self references, full URLs, x-default and supported language codes).
