# Independent technical review: multilingual blog release

Reviewer: Codex agent `/root/blog_latin_translations`, independent of the parent agent's implementation. Review date: 10 September 2026. This is an AI-assisted code and local-artifact review, not a human/native-speaker certification, browser/device acceptance, or production-deployment proof.

Verdict: no unresolved blocking technical finding in the reviewed scope. Three concrete issues raised during this review were corrected by the parent and independently rechecked. The final approval manifest and all locally generated first-selection pages pass the checks below. Production deployment and public-response verification remain separate parent-owned gates.

## Scope and method

Read the complete implementations of `scripts/blog/lib/localization.js`, `scripts/blog/build-blog.js`, `scripts/blog/lib/templates.js`, `public/js/blog-language.js` and `i18n/runtime.js`, plus the Markdown/format integration, relevant test files and release workflow changes. Reviewed the locale registry, blog CSS direction rules, consent/measurement integration, Support return-path use and the release documentation where relevant.

Checked publication admission, preview isolation, source/translation/UI hash matching, same-origin URL handling, stable English heading anchors, reciprocal alternates, self-canonicals, localized/fallback links, language preference persistence, RTL rules and the distinction between translated prose and original English evidence assets.

The reviewer did not edit application code, build code, release workflows, approval records, publication state or generated pages. Proposed fixes were sent to the parent. The reviewer did not modify any of the three sealed editorial reports after the manifest was created.

## Findings and verified fixes

| Finding | Original impact | Verified final behavior |
|---|---|---|
| Preview HTML could survive a later normal build | The renderer only wrote admitted variants. A prior preview could leave unreviewed article/hub HTML in the deployable output tree even when absent from sitemap and alternates. | `assertNoUnreleasedTranslationPages` recursively checks all nine locale directories against publication-state article and hub paths before any non-preview build writes. Extra HTML and symlinks are rejected without deletion. The verifier checks all admitted outputs, including future articles outside the fixed first selection. Both deployment workflows rebuild recorded releases, reject artifact diffs and run the full verifier. |
| Translated UI prose was not bound to approval hashes | Key/placeholder checks alone would allow a changed disclaimer or navigation string to render while article hashes remained unchanged. | `loadTranslations` requires the current locale UI hash, its reviewed English-reference hash and the manifest-wide English UI hash to agree before a recorded/new translation is admitted. Tests reject both a changed translated disclaimer and changed English reference. |
| Footer Support return path discarded the locale | The common footer always set `returnTo=/blog/`; Support's back link would therefore return a localized reader to the fixed-English hub. | `localizedChrome` changes this exact footer destination to the locale's encoded hub path. French and Arabic generated-HTML tests verify `/blog/fr/` and `/blog/ar/` return targets. Source-article destinations are not changed by this fix. |

## Other reviewed behavior

- English URLs remain stable; translated URLs use the registered locale and unchanged source slug. Unsupported or malformed route identities are rejected.
- Matching translated blog links are localized; English-only targets remain explicitly labelled. English section IDs are preserved positionally after translated heading structure is checked.
- Released article variants have reciprocal alternate sets and self-canonicals. Preview translations are noindex and absent from production sitemap/alternate sets.
- Reading or opening a localized article does not save an application language preference. The fixed document language survives another tab's preference change. A deliberate same-origin onward product link uses the existing preference API; unavailable storage does not block navigation.
- Arabic document/element direction is explicit. The skip link and narrow-page minimum-width fixes are covered by contract tests. The language picker has keyboard focus styling and Escape behavior. These checks do not replace rendered RTL/device or accessibility-conformance testing.
- Source images remain unchanged; translated alt text/captions and the original-English-image disclosure are emitted. Source and next-step headings are localized without duplicate Sources sections or fallback English CTA copy.
- The measurement tests retain bounded editorial locale identifiers and existing consent gates; no new advertising conversion or spend action is part of this review.

## Approval-manifest verification

Independently verified every record in `content/blog/translations/reviewed.json` against the current local files and the sealed reports:

- 63/63 complete source SHA-256 values match.
- 63/63 final approved translation SHA-256 values match.
- 63/63 original reviewed SHA-256 values are reproduced by changing only the exact frontmatter status line from `approved` back to `in_review`; parsed Markdown bodies remain strictly identical.
- 63/63 article identities, decisions and review methods match; author/reviewer task identifiers are distinct.
- 9/9 translated UI hashes match, with 40 keys and unchanged placeholders per dictionary. Every UI record is linked to the current English UI reference.
- 72/72 reviewed article/UI fingerprints are present in the corresponding sealed editorial reports.
- 3/3 sealed editorial-report hashes match the manifest.
- The English reference UI was independently read in full: 40 values, including the original-image disclosure, software-only/no-included-media disclaimer and dynamic `{count}` notice.

All SHA-256 values in this review use complete file text with CRLF normalized to LF.

| Evidence | SHA-256 |
|---|---|
| `content/blog/translations/reviewed.json` | `aa48eecd5969537519bfd61128972feef379d16c30f07d8e0304cd77a11f0ab9` |
| `content/blog/i18n/ui/en.json` | `ab14080d6ffb7ba84820d4e72682737d44987fdbabcec358935d97494515870d` |
| `content/blog/i18n/reviews/cross-review-fr-es-pt-BR.md` | `173665fcc366d82fd84c79955b25b0c3729de02f50c3940fdaf1ca41e9b71bcf` |
| `content/blog/i18n/reviews/cross-review-tr-id-fil.md` | `6198c76e1c619c7df4d078f03f51d5fd9c74be99b43b1c47172c3fbdb49dcdf7` |
| `content/blog/i18n/reviews/cross-review-hi-bn-ar.md` | `161a8e55b7dd853078a40342be82e5c98e0d3daaa4140030df02f0ae019486cf` |

The final-byte admission gate validates source, translated article, translated UI, English UI reference and the approval decision. The status-only transition and the report fingerprints above were also independently reconstructed for this specific manifest; this is not a claim that automation can determine whether a human or agent actually performed an editorial reading. The approval ledger is the explicit authorization record.

## Independently executed checks

1. `node --test tests/blog-localization.test.js tests/ui-language.test.js tests/blog-editorial-rendering.test.js tests/blog-measurement-contract.test.js`: 43 tests passed, zero failures/skips at that review stage.
2. After the final UI-hash and Support-return changes, `node --test tests/blog-localization.test.js`: 12 tests passed, zero failures/skips. This included the newly added UI-review gate test and the French/Arabic Support-return assertions. These runs overlap; their counts are not added together.
3. Independent manifest assertions checked all counts and fingerprints listed above: PASS.
4. `node scripts/blog/verify-localizations.js --expect-complete`, against the parent's final locally generated release output: exit 0; 70/70 first-selection article versions, 10 language hubs, 117 existing English articles, 190 sitemap URLs, zero findings. The 70 versions are seven topics across ten languages, not 70 new topics.

These reviewer-run Node checks used the local PATH runtime, Node v24.14.1. The parent rendered the release with Node 22.22.3 to match CI/ICU; this reviewer did not re-render the release tree with Node 24. The checks above are local verification, not live HTTP/browser proof. The complete repository suite, final CI, actual deployment, search indexing and commercial outcomes are outside this independent execution claim.

## Reviewed implementation fingerprints

| File | SHA-256 |
|---|---|
| `scripts/blog/lib/localization.js` | `f4263a85796d6fbbc0aeb85aba0c3bff211ba92a545353a135c708766a6aa42e` |
| `scripts/blog/build-blog.js` | `9dbdf423a99ce1f1bf0e6c9e882fc7cc3e186aa2094b8614510cd592042e275e` |
| `scripts/blog/lib/templates.js` | `6d5ecb98524cbc07df73961a712e877d86ea830b90c615f11b8accedaccc6a49` |
| `scripts/blog/lib/markdown.js` | `d8ef0f15c59e19195396d777c69412d8b4cbe857fae566c61fe643e3c7190f75` |
| `scripts/blog/lib/format.js` | `0b031be68b78504dff2b2db0a2d52db23b3631277ef77674dc9f31a20bffa18d` |
| `scripts/blog/verify-localizations.js` | `dd33f23c98110916e0cae99babe106356bc2bd5291e37302d8215d6050f530cc` |
| `public/js/blog-language.js` | `1ced86bfd22aeb932f59cbbdf73b036f08d3a4e07054166475acf478f7eba8c2` |
| `i18n/runtime.js` | `2e34b1202e5656f8c777208e534835986fb4a6227257dc55ec3c988dcd5142e4` |
| `tests/blog-localization.test.js` | `949e0acda8492c4b4803f7a26120e6502c4d5bb99ff190a56d6197e6a5b17e93` |
| `tests/ui-language.test.js` | `64ebd293c148fa2b8f59c5d104620cc076d72b0d67c58987978f6b2123dff000` |
| `public/css/blog.css` | `ddf3dd9383561b12bb69417bf6b9e27d408817c2e83cdf3690d3c85f6585ffb4` |
