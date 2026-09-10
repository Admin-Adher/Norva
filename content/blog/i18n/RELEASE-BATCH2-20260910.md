# Second multilingual editorial batch

## Scope and owner authorization

The owner requested ten other already-published articles, improved for useful search intent and made available in all ten Norva languages. On 10 September 2026 the owner confirmed: **“Oui, même processus et mise en production”** in reply to the question explicitly covering 100 versions, parallel work, double agent review and production after validation.

This authorizes ten revised English originals and ninety complete translations. It does not authorize an expansion of the publishing calendar, changes to advertising, commercial analytics configuration, account state, or an additional country-budget decision. The earlier seven-article release and premium localized hub UI remain in place.

For this batch only, the owner accepts author self-review plus a different agent's complete independent review, followed by parent technical/rendered acceptance. This is **AI-assisted cross-review, not human or native-speaker certification**. Do not populate a fictitious human-review identity. Hash-bound final decisions belong in `translations/reviewed.json` and the actual reviewer reports.

## Selection evidence

Owner-authorized Search Console data was inspected live on 10 September 2026 for Web search and blog pages, across all devices and countries, with three-month and 28-day controls. Only the active visible table was extracted. Page totals were reconciled; hidden historical tables were excluded. Detailed private metrics and query exports are retained in the owner's local audit artifacts, **not published in this public repository**.

The periods overlap, article ages differ and query rows are partially anonymized: neither a growth rate nor a profitability ranking is inferred. Query-level and page-level totals must not be equated. Country totals and session-start events are not used to choose a market or claim commercial conversions.

| Existing ID | Distinct reader task |
|---|---|
| 028 | Preserve series, season, episode and special order |
| 161 | Search systematically without over-constraining a query |
| 422 | Choose handoff, mirroring or receiver playback |
| 442 | Choose shared or separate viewing contexts |
| 502 | Distinguish embedded, external and burned-in subtitles |
| 561 | Diagnose visible quality across the playback chain |
| 582 | Distinguish gain, loudness and peaks |
| 602 | Interpret capacity, throughput, latency and jitter |
| 662 | Compare TV launch states and readiness milestones |
| 721 | Reconcile and maintain offline storage safely |

Selection combines small observed search-intent signals, complementary product journeys and verified editorial gaps. These are not traffic forecasts. No new English URL or unpublished topic is brought forward.

Google Trends was additionally read in the actual browser after the web research tool could not retrieve its series. Scope: Worldwide, past 12 months, all categories, Web Search, English **search terms** `video quality`, `subtitles`, `screen mirroring`, `video buffering`, `media player`. It exposed 53 weekly buckets (7 September 2025–6 September 2026; last bucket incomplete). The normalized comparison is not an absolute volume or ten-language demand estimate. Related lists contained obvious off-topic retail/navigation queries; those were excluded. The useful definition intent “what is screen mirroring” supports a clear answer in 422, not a predicted growth percentage. No Trends percentage is inserted into the public articles.

Local evidence companion, outside Git: `.codex/tmp/norva-blog-seo-batch2-20260910/` contains the four GSC extracts, the Trends extract, and a rerunnable selection notebook. The notebook reconciles inputs and reports missing rows as not reported rather than zero. It is a selection audit, not a sales or ROI report.

## Editorial changes and boundaries

- Preserve source IDs, English slugs, canonical URLs and original publication instants. Existing H2/H3 anchors are retained where practical. `updated_at` records the material revision; translation publication instants are recorded only during the explicit release.
- Add completed, topic-specific worked examples instead of merely adding FAQ, summary or empty worksheets. Fictional people, media, measurement values and decisions are labeled as teaching examples, never as customer evidence or Norva benchmarks.
- 161 reuses the unchanged, verified 10 September English web filter screenshot and the recorded source/filter/search/detail observations. The caption states its language and limited scope. It does not establish playback, every audio track, casting or native-device behaviour.
- Recheck primary technical sources and current Norva positioning. For example, 602 replaces obsolete delay/loss RFC references with RFC 7679/7680; 662 uses Android startup documentation instead of treating web timing standards as native TV proof.
- Current public descriptions of profiles, Google Cast and conditional offline availability are distinguished from tested device combinations. No universal codec, subtitle import, playback, synchronization, price or network threshold claim is introduced.
- Keep one relevant next action, useful links to already-published related articles and the player-with-authorized-personal-source positioning. Do not alter the earlier seven sealed source hashes for link-building.
- Translate complete metadata, prose, tables, examples, FAQ, link labels and image descriptions into French, Spanish, Brazilian Portuguese, Hindi, Bengali, Arabic, Turkish, Indonesian and Filipino. Preserve technical units and illustrative assumptions. Arabic remains RTL and Filipino uses the existing `fil` route / `tl` hreflang mapping.

## Technical release gates

The cumulative explicit selection is seventeen English sources and nine translations each: **170 selected versions**. With the current baseline of 118 published English sources, the intended site contains **271 article pages plus ten language hubs**. Recompute these counts if the existing scheduled publisher advances; do not suppress or manufacture calendar entries.

Required before publication: source/translation cross-review; normalized SHA-256 binding; complete-body structure and rendered metadata checks; reciprocal language links and self-canonicals; localized navigation/CTA checks; no draft/noindex leakage; sitemap and actual first-publication date preservation; focused and full tests; clean deterministic Node 22 rebuild. Preview output must be replaced by a non-preview explicit translation release before deployment.

Production acceptance is separate from Git and CI: fetch the deployed pages and compare article bodies, structured data, dates, canonical/hreflang, assets and sitemap against the approved release. Successful deployment cannot establish Google indexing, better ranking or commercial conversion. Observe later comparable Search Console windows before drawing those conclusions.

## Primary methodological references

- [Google: helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Google: localized page versions and reciprocal hreflang](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [Google: descriptive title links](https://developers.google.com/search/docs/appearance/title-link)
- [Google: useful search snippets](https://developers.google.com/search/docs/appearance/snippet)
- [Google Trends: normalization, low-volume limits and interpretation](https://support.google.com/trends/answer/4365533?hl=en)

## Local acceptance before Git publication

Completed on 11 September 2026 (Europe/Paris), from an isolated worktree based on `636c9b032e4f6827b3187f5187a2e8a2f27a593f`. The original working checkout was not used for edits or staging.

- Ten English sources passed complete author and independent agent reading. Ninety translations passed author self-review and a different agent's full review, with all corrections closed. `review-batch2-en.md` and the seven `cross-review-batch2-*` reports record the actual reading scopes and exact fingerprints; the ledger records author/reviewer provenance without claiming human certification.
- The mechanical approval transition changed only ninety `translation_status` values. All ninety source, reviewed-body, final-file and report fingerprints were verified. The previous seven English source files, sixty-three translation files and release records, ten UI dictionaries, and publication calendar remain unchanged. All 118 English first-publication instants remain unchanged.
- The explicit release records the ninety new translation publication instants as `2026-09-10T22:33:41.694Z`; this is not backdated to their English originals. It produces 153 translated articles, 118 English articles and ten hubs. `--expect-complete` verifies 170 selected versions and 281 sitemap URLs with zero findings, with preview mode disabled.
- Final Node 22.22.3 full regression run: **4,190 tests, 4,179 passed, zero failed, eleven skipped**. Focused blog run: **67/67 passed**, no skips. Whole-corpus validation covers 1,000 source documents with zero problems; generated app locale checks and the region model pass.
- Rendered checks covered all ten hubs at desktop and 390 CSS pixels, without detected horizontal overflow; French search, empty result/reset and topic filtering; actual navigation through all ten language links for the same storage article; representative English, French, Arabic, Hindi and Filipino article layouts, TOC/table behavior and unchanged evidence images. The reviewed browser console had no warnings or errors. These are browser checks, not native-device or formal accessibility certification.
- The final local HTTP comparison passed **292/292 checks**: all 281 pages, nine unchanged evidence images, the sitemap and robots policy. Main content, titles, descriptions, structured dates, canonical/hreflang, language/direction and asset bytes match the release. Live verification additionally rejects restrictive `X-Robots-Tag` headers and changes to the reviewed robots policy. Mock regressions are not represented as production observations.
- A normal Node 22 rebuild after the explicit release wrote **zero changed pages** and preserved release state. No publishing-calendar expansion, Ads action, analytics setting, account change, app feature change or native release is included.
- The cached whitespace check reported only terminal blank lines in 21 new translations and one review report. These exact reviewed bytes are intentionally retained; no post-review prose or fingerprint is changed for cosmetic EOF normalization. The remaining Git whitespace checks pass with the per-command `core.whitespace=-blank-at-eof` setting; no repository/global setting is changed.

The Git commit is a locally accepted release candidate, not itself evidence of deployment. The existing Cloudflare workflow must pass its own rebuild/regression gates, and the parent task must run the same read-only comparison against `https://norva.tv` after deployment. That final public result is recorded in the task's handoff and local audit artifacts; indexing, rankings, traffic and conversions remain unproven by a deployment check.
