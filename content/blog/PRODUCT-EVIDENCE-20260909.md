# Web setup evidence for NVB-014 and NVB-015

Prepared 9 September 2026; live test evidence added 10 September 2026. Local editorial revision only; no publication or human approval is implied. All existing status, robots, canonical, publication-date and human-review fields are preserved. The 9 September record below is historical and is superseded only where the 10 September observations explicitly say so.

## Observed product controls

The signed-in public web interface was inspected read-only at `https://norva.tv/app#settings/sources` after navigating through the account menu and Settings. The source tab was shown in French on that account; the articles use the corresponding English component labels and explicitly explain localisation.

The inspected controls were Add playlist / Add provider, the M3U link / Xtream login format tabs, the M3U URL and optional name inputs, the first Xtream connection step, and the app-only-login help panel. Opening, switching tabs, opening help and returning did not submit a source or change account preferences. No personal account screenshot is included.

## Capture provenance

The three PNGs under `public/assets/blog/` are direct browser captures of the unchanged `SourceManager` component and Norva CSS from isolated baseline `fca413f8`. They are not generated UI mockups. A small local harness supplied the normal modal container, enabled the provider-access UI branch observed live, and stubbed the API availability check. It bypassed account loading and disabled source submission. Its local server blocked external connections. All input values are empty; example URLs and names are the component's built-in placeholders, not credentials.

| Asset | Observed state |
|---|---|
| `source-m3u-web-20260909.png` | M3U selected, empty URL/name fields, Cancel/Add controls |
| `source-xtream-web-20260909.png` | Xtream selected, Connect provider step 1 of 5, manual-details option, Continue control |
| `source-app-login-help-web-20260909.png` | Built-in compatible-format explanation and provider-request message |

Raw source SHA-256 at capture time:

- `public/js/components/SourceManager.js`: `5f055ae1487e5053bb0182eb83c52b28eb75a672eb4eda44ca1189c8bec5061b`
- `public/css/main.css`: `3934415975e34ce99607e935f0210319556fe0bb29bce910bb5cbcb11adb4a87`

## Scope and release gate

This evidence verifies visible web controls and guidance. It does **not** verify a provider's rights, compatibility, successful import, catalogue loading, playback, favourites, account continuity, native phone UI, or native TV remote navigation. Those later steps are presented as reader checks, not as completed acceptance tests. The generic draft banner has been replaced with this narrower, visible verification scope; `product_claims.verified` remains false and human review remains pending.

Before approving the tutorial as fully tested, a reviewer must use a controlled authorised source, record the product/device version, complete import and a known-item check, and validate each additional platform actually claimed. Do not remove the verification boundary merely because the rendered article passes.

On 9 September, the proposed source-settings CTA targeted the route inspected live; following it could require authentication. No subscription, payment, source creation, deployment, analytics administration or Ads configuration change was performed in that initial inspection.

## 10 September: live test-account walkthrough

The user explicitly made the signed-in test account available and then provided a test Xtream access for the source-import walkthrough. Credentials were entered only into the official Norva app. They are not included in articles, screenshots, this evidence file or test fixtures. The existing playlist was preserved. Exactly one new source was submitted, using the neutral nickname `Blog walkthrough test`.

The interface was temporarily switched from automatic device language to English for the English articles. No consent reset, authentication change, subscription purchase, access dates, renewal or reminder was configured. Opening the source wizard may produce normal product telemetry; these are test interactions, not evidence of commercial conversions. GA4 and Ads administrative settings were untouched.

### Captures replacing the local harness in the articles

The new `*-live-web-20260910.jpg` images are direct viewport screenshots of the signed-in production web app, not the isolated harness and not generated or retouched UI. The app's own modal backdrop blurs the background. Captures were reviewed visually; secret fields are empty or absent, and no account identifier or private connection URL is readable. Viewport 1116 × 975 CSS pixels. The browser's existing zoom was left unchanged.

The browser returned JPEG bytes. The five new files were mechanically renamed from the initially assigned `.png` suffix to `.jpg` so their extensions match the actual encoding; each SHA-256 remained identical before and after renaming. No conversion, crop or retouch was performed. The three older isolated-component PNGs above were not changed.

| Asset | Observed live state |
|---|---|
| `source-m3u-live-web-20260910.jpg` | Empty M3U form; no M3U submission |
| `source-xtream-live-web-20260910.jpg` | Empty Xtream entry step before entering test access |
| `source-app-login-help-live-web-20260910.jpg` | Actual app-login compatibility help |
| `source-access-period-live-web-20260910.jpg` | Add this later selected; step counter changed to 2 of 3 |
| `source-importing-live-web-20260910.jpg` | Actual Importing state; connection check Done; catalogue preparation in progress |

The earlier isolated captures are retained as historical evidence but no longer used by articles 014, 015 and 089. No new file contains the supplied credentials or server address.

### Observed submission sequence

1. Account menu → Settings → TV Service → Add provider.
2. Xtream login → Enter server login manually; enter only user-provided values and neutral service nickname.
3. Continue → Provider access period → Add this later.
4. Continue → Review, Add later / No new dates → Finish without dates once.
5. Preparing your catalog appeared. Connection check was Done, overall state Importing. Counts increased during observation; at one intermediate observation the UI showed 8,360 films and 371 series detected, with 18% progress. These are intermediate UI counts, not verified complete-source totals or a performance benchmark.

### Navigation finding

A direct navigation to `https://norva.tv/app#settings/sources` displayed Home despite retaining that hash. The visible account menu → Settings path opened TV Service correctly. Article 015 therefore links to `/app` with explicit menu instructions instead of promising that its CTA opens source settings directly. No production app routing code was changed.

### Remaining acceptance boundaries

At the intermediate observation above, preparation had not reached a final Ready state. An accepted connection and detected titles are not equivalent to a completed import or successful playback. No M3U submission, native Android phone or TV interaction, cross-device continuity or offline acceptance was performed. Human editorial approval remains pending. Later observations, if obtained, must be recorded explicitly below before widening the article's verification claims.

## 10 September: search, tags and player check

After closing the preparation modal (without cancelling or resubmitting the import), Movies → Source → Blog walkthrough test displayed titles from the new source. Searching for a previously visible title, The Squad: Home Run, and opening its details produced eight versions. No new source was added during this check. The server response consumed by the UI still reported `sync_status: syncing`, `sync_error_code: null`, `catalog_visible: true`, and reminders disabled.

The user noticed the incomplete tags and requested a cause investigation before continuing editorial work. The diagnosis was read-only:

- A fresh, actual UI search response contained eight records. Every metadata object contained only `categoryId`, `categoryName`, `rating`, `added`; year and release year were null. No audio-language or enriched-genre fields were present. Provider URLs, playback hints, source identifiers and credentials were not exported.
- The raw title prefixes were AR, DE, GR, HU, NL, PL, RU and SO. The source labels described markets/collections rather than verified film genres. The page showed Language unidentified; HU and SO additionally displayed Hungarian and Somali in the secondary line.
- Local reproduction of the actual formatter matched this inconsistency: `public/js/utils/mediaUtils.js`, `versionDescriptor`, suppresses a market hint when it equals the separately parsed prefix-audio label. HU and SO exist in the market dictionary without the equivalent prefix-audio mapping, so their secondary hints survive. These are not probed audio tracks. No formatter fix was applied.
- The inspected import code intentionally projects discoverable items with `vodInfoLimit: 0` and `tmdbValidateLimit: 0` (`supabase/functions/_shared/xtream-sync.ts`). The default final projection also uses zero unless deployment configuration overrides it. The finalization-quiescence migration requires a Ready source and no active finalization lease before the audio fleet can select it, and guards TMDB work against concurrent finalization. Ready is not equivalent to complete enrichment.
- The deployed Edge/environment/migration versions were not separately verified. The actual sparse API response and syncing status are current evidence; implementation details above describe the inspected isolated checkout and explain a compatible mechanism, not proof of all deployed worker settings or eventual completion.
- Most observed market categories classify as Other without enriched genres. The AR category would classify as Arabic Collection if it were the canonical title's genre category. A title can inherit a different variant's category, so the detail card's AR label alone does not prove a category-loss bug. Canonical-title genre fields were not retrieved in this investigation.

One Play action opened the watch route. At two observations, the video element remained at time 0, readyState 0, paused, with zero decoded dimensions and no media error code. No relevant console error was captured. This does not establish the playback failure mechanism or prove source incompatibility. Back returned to the title; no retry, another title play or account-action mutation followed. No successful playback, complete import, favourite persistence, cross-device or native acceptance is claimed.

The diagnostic screenshot `tags-live-detail-20260910.jpg` is stored outside the repository under the local scratch directory, not used as a blog image. Article 015 and the organisation article distinguish source labels, incomplete metadata and real playback evidence. No production product code or backend state was corrected for the tag diagnosis.

## 10 September: editorial resumption after the language release

The blog edits were transferred, without generated HTML or publication-state files, into an isolated worktree based on `fbb1ba05bda13ac9a13b6f7d504638482bc69555`. This follow-up supersedes the earlier in-progress observation only for the outcomes explicitly listed here.

- The user approved a temporary change from Automatic — device language to English for screenshots. The original Automatic option was restored afterwards. No audio/subtitle preference, consent setting or authentication setting was changed.
- Account menu → Settings → TV Service showed the previously added neutral test source as **Ready**, with **No period recorded**. No source was submitted, synced manually, disconnected or duplicated during this follow-up. Connection details were not captured in the new image.
- Movies → Filters retained that source and All Categories. The Audio language menu offered **Albanian · 6,235** and **Nordic languages · 2,733**, among other options. Selecting Albanian returned visible cards with Albanian badges. These are UI facet counts at observation time, not independently verified distinct-film totals or proof of actual audio tracks.
- The final new asset, `catalog-audio-filter-live-web-20260910.jpg`, is a direct, unaltered full-viewport screenshot of the live English filter panel (869 × 975). It shows a neutral source nickname and no private server address, user identifier or credential. The browser supplied JPEG bytes; no conversion or retouch was applied. Experimental clipped captures had incorrect framing and were discarded without saving or use.
- **Clear all** removed the audio condition. Searching the known title returned one grouped card with **12 versions**, a 2023 year and 93-minute duration. Opening the group showed a synopsis and twelve version buttons. This is displayed metadata, not independent verification of each field. Back returned to the same search result.
- One **Favorite** action was attempted before Back. The result card still showed **Add to Favorites**, and reopening details showed **Favorite**. Persistence was not confirmed and is not claimed in the articles. No existing favourite was deliberately removed. This result is recorded as an acceptance gap, not a diagnosed cause or a completed account-state test.
- No Play action, media probe, M3U import, native phone/TV test, offline test or cross-device check was performed in this follow-up. The earlier non-starting playback observation is historical and was not reproduced as a current defect.

Articles 014, 015, 027 and 089 now describe the Ready state and current catalogue interactions rather than presenting the old eight-version/incomplete-import state as current. Technical examples remain clearly labelled as authored illustrations. All human-review and release gates remain unchanged; this resumption does not authorise or perform publication.

### Final favourite recheck

A later return to Movies and the same search showed **Supprimer des favoris**, confirming that the earlier favourite action had persisted. We clicked that control once to restore the original unfavourited state. After a full reload the same result showed **Ajouter aux favoris**. The search was cleared and Series reopened. This supersedes the earlier unconfirmed-persistence result for this item only. Immediate UI feedback and propagation timing were not established. Articles 014/015 and the current review distinguish the confirmed persistence/removal from the unaccepted immediate-feedback and cross-device checks.
