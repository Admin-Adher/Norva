# Blog measurement readiness — 2026-09-09

Original status at preparation: local implementation and isolated tests only. The later user authorization and release checks are appended below. No GA4 administration change, Google Ads action change, purchase, or real-user consent action was performed by this work. Production historical data is not repaired by this patch.

## Live preflight refresh — 10 September 2026

The GA4 administration UI and Google Ads read-only API were inspected again around 01:43–01:46 Europe/Paris. This refresh changes the readiness assessment, not any remote setting.

- **`session_start` is currently not a GA4 key event.** The recent-events table explicitly shows its key-event checkbox unchecked, across two active streams. The key-events tab lists exactly five entries: `app_store_subscription_convert`, `app_store_subscription_renew`, `first_open`, `in_app_purchase`, and `purchase`. The historical five blog key events in the earlier report do not establish the present configuration or the date it changed. No action to unmark `session_start` is currently needed.
- **Six event-scoped custom dimensions exist:** `auth_method`, `selected_plan`, `journey_name`, `journey_outcome`, `event_source`, and `journey_step`, all shown as last modified on 1 September 2026. None of the eight proposed blog/environment dimensions below is registered. Preserve these six existing definitions; do not recreate `event_source`.
- **Ads account identity was resolved, not inferred from URL parameters:** Norva customer `7019250623`. Thirty-four conversion actions were returned. Web GA4 `session_start` (`7684592149`, property `543876012`) and Android `session_start` (`7668866874`) are enabled but secondary. Enabled is not the same as a primary bidding action.
- **Current campaign scope was checked:** Search India (`24198137021`) uses campaign-specific Website PURCHASE, SIGNUP, BEGIN_CHECKOUT and SUBSCRIBE_PAID goals, with PAGE_VIEW explicitly excluded. Its current strategy is TARGET_SPEND; inclusion among conversion goals does not mean the campaign is using conversion-based bidding. App India (`24203190874`) and App Bangladesh (`24210014597`) select only Android First open (`7668866856`) for optimisation. No custom conversion goal was returned; all three campaigns remain paused. No current bidding dependency on `session_start` was observed.
- **The primary Website actions are direct Ads WEBPAGE actions**, not GA4 imports: Norva - Inscription (`7684674684`), Norva - Essai (`7684674690`), Norva - Début paiement (`7684674687`), and Norva - Achat (`7684674693`). Changing a GA4 key-event flag would not by itself repair or replace those direct event calls. Their live business outcomes were not tested by this configuration inventory.

The source UI pages were GA4 Administration → Events and Custom definitions for property `543876012`. Ads checks used account/action listings and read-only queries of campaign selective optimisation, campaign/customer conversion goals, conversion-goal configuration, custom goals and action metadata. The inventory does not prove the absence of downstream dependencies in audiences, exports, reporting or authentication referrals. It is not authorisation to change any configuration. Recheck configuration before any later release or campaign reactivation.

## What was verified

The earlier read-only audit of property `543876012` (`norva-ecosystem`), 11 June–8 September 2026, reported five key events on blog-landing sessions; all five were `session_start`. No registration, trial, checkout, or purchase was demonstrated for that cohort. These counts must not be described as five commercial conversions. This is historical report evidence, not evidence that `session_start` is still marked as a key event; see the live refresh above.

The fresh `origin/main` baseline (`fca413f8`) contains a concrete namespace problem: ProductAnalytics sends its interface placement as `source` to NorvaMarketing, and the marketing adapter forwards it unchanged to `gtag`. Clarity already calls that same concept `event_source`. The patch normalizes this boundary to `event_source` with a closed list and leaves the native/product vocabulary unchanged. Invalid source values are dropped, and the caller's object is not mutated.

This is a verified code defect/risk, **not proof that it explains every historical attribution row**. The current consent banner does not emit a `source: 'consent'` event, and the current code does not set `campaign_source` or rewrite UTMs. The historic `consent/(not set)` and `landing/(not set)` rows still need an approved browser-network/realtime check after deployment. Preserve the audit before/after cut; do not rewrite history or promise retroactive repair.

## Local instrumentation

The blog template owns `data-blog-article="<canonical-slug>"`. The adapter verifies that it matches `/blog/<slug>/`; it never reads identity from a query string. The index uses `article_slug=blog_index`.

| Event | Meaning | Context |
| --- | --- | --- |
| `blog_view` | One consented load of a blog page, once per document | `article_slug`, `event_source=blog`, `content_group=blog`, `measurement_environment` |
| `blog_cta_click` | A click on an explicitly identified blog CTA, not signup or trial | Above plus `cta_placement`, `cta_target` |
| Existing real funnel event | An event already emitted by an account, billing, or product flow | Optional `blog_article_slug`, `blog_cta_placement`, `blog_cta_target`, `blog_context_model=last_cta_30m`, `measurement_environment` |

`cta_placement` is one of `nav`, `primary`, `inline`, `footer`. `cta_target` is classified from a same-origin HTTP(S) link into a closed list (`signup`, `app`, `source_settings`, `pricing`, `features`, `how_it_works`, `product_preview`, `support`, `legal`, `blog`, `home`, `other`). Unknown or external destinations are only `other`. No CTA text, full URL, email, provider detail, account identifier, UTM, or URL query is added to these custom parameters. This guarantee concerns the new custom parameters; the existing Google tag's automatic page metadata and its consent behavior have not been replaced.

`blog_view` and `blog_cta_click` are sent explicitly to the GA4 measurement ID only. The same click is no longer also sent as the generic `select_content` event. Neither event is converted into a lead, signup, trial, purchase, Google Ads conversion, or Meta event. No Clarity Smart Event slot is consumed and Clarity is not enabled on new paths.

### Consent, association, and limitations

- Before consent: no blog event, tag load, click persistence, or replay of an earlier click. On opt-in, one view of the current document may be emitted; prior clicks are not replayed.
- Only a consented article CTA click records `norva_blog_context_v1` in first-party `sessionStorage`. A plain view and an index CTA do not record article association. Records hold only the bounded slug/placement/target, schema version, and a local expiry timestamp.
- The association is the most recent eligible CTA in the **same tab**, for strictly less than **30 minutes after the click**. It is not refreshed by later funnel events. Malformed, future-dated, or expired records are rejected. Storage failure falls back to event-only measurement.
- Refusal or the existing Manage cookies reset removes only this context key. Native Android WebViews do not load the browser tags or use this context.
- The adapter decorates only the existing events `signup_started`, `sign_up` (normalized from `signup_completed`), `login_started`, `login_completed`, `pricing_viewed`, `plan_selected`, `checkout_started`, `begin_checkout`, `checkout_completed`, `start_trial`, `purchase`, `provider_connect_started`, `provider_connected`, `catalog_ready`, and `playback_first_frame`. It never manufactures these events.
- Decorated events are explicitly sent to GA4. Google Ads conversion IDs/labels, triggering conditions and business parameters (value, currency, transaction identifier) are preserved; the common marketing boundary can rename the optional interface parameter `source` to `event_source`. No blog association is added to the separate Ads conversion or Meta calls, and the native bridge is unchanged.
- This is **click association**, not Google acquisition attribution, causal incrementality, or seven-day revenue attribution. It does not join devices, tabs, delayed trial renewals, server webhooks, or users who decline consent. A same-tab auth redirect can retain the context; a new tab, long email-link delay, or expired context may not. Mature trial-to-paid measurement needs a separately approved consent-aware server/billing join, not a longer-lived browser identifier added here.
- `measurement_environment` is `production` only on `norva.tv`, otherwise `qa`. It helps segment preview diagnostics; it does not automatically identify internal people on production, turn on DebugView, or exclude data.

## Administrative checks still requiring approval

1. **Preserve the verified key-event state and complete only missing dependencies before proposing changes.** The 10 September refresh confirms that `session_start` is not currently a key event and that its Ads imports are secondary and not selected by the inspected campaigns. No unmarking action is needed. Audience, export, reporting and attribution dependencies remain unverified. Do not delete, reclassify, mark or switch any event/action without reviewing the intended effect and receiving approval. Do not mark `blog_view`/`blog_cta_click` as commercial conversions.
2. **Verify true outcomes independently.** Use the existing `sign_up`, authoritative `begin_checkout`, server-confirmed `start_trial`, and captured `purchase` events with their actual semantics. A checkout attempt is not a paid subscription. Confirm duplicate prevention, values/currency, and transaction identifiers without conducting an unapproved real payment. Browser trial-start reporting does not prove the later recurring charge is imported correctly.
3. **Register only necessary event-scoped dimensions**, after checking existing definitions/quotas. Keep existing `event_source`; proposed new definitions are `article_slug`, `cta_placement`, `cta_target`, `blog_article_slug`, `blog_cta_placement`, `blog_cta_target`, `blog_context_model`, and `measurement_environment`. These are proposed, not remotely created. Prefer built-in page and acquisition dimensions for ordinary page/source reports. No timestamp or per-user/session ID custom dimension is proposed.
4. **Audit authentication referrals before excluding them.** Reproduce a normal entry → blog CTA → authentication return with the user's manual consent and authentication actions. Check the initial source/medium and the callback's referrer. `accounts.google.com` may represent an authentication return; it is not automatically evidence of internal traffic. Decide on a narrowly scoped unwanted-referral rule only after confirming the real flow. Never add blanket `ignore_referrer`, and never exclude all of `google.com` or `search.google.com`.
5. **Separate testing without silently losing production data.** Use local mocked tests first. After an approved release, use an explicit QA window and reviewed GA4 developer/internal-traffic filter configuration (test state before active). Tag Assistant referrers suggest tests, but do not justify deleting all historical visits. Review acquisition reports with and without the documented QA cohort.

Google documents that `session_start` is collected automatically, that it carries acquisition context, and that session counts use estimation: [Analytics sessions](https://support.google.com/analytics/answer/9191807?hl=en). Campaign parameters have acquisition meaning and can override UTMs: [GA4 configuration](https://developers.google.com/analytics/devguides/collection/ga4/reference/config). Custom parameters require report definitions, with reporting delay and cardinality considerations: [Custom dimensions](https://support.google.com/analytics/answer/14240153?hl=en). Referral exclusion has attribution effects and should not be applied indiscriminately: [Unwanted referrals](https://support.google.com/analytics/answer/10327750?hl=en).

## Release and acceptance gates

1. Review this local patch and article previews. Publication is not authorized by this readiness document.
2. On a separately approved release, ensure **all** pages loading `marketing.js` receive the new asset hash. Blog templates derive it from the asset; the existing `hash:assets` deployment step covers account, app, and checkout references. The source checkout's unchanged `?v=5` is not evidence a previously cached browser has the new adapter.
3. Run the isolated contracts below. They mock tags/storage and send no requests to Google or Meta; this is local validation, not production acceptance.
4. In an approved real-browser verification, let the user make consent/auth decisions. Check no outbound analytics before opt-in, one blog view afterward, one classified CTA event, no `source=landing/consent` custom parameter, unchanged UTMs/referrer, and optional blog association on a genuine signup. Confirm refusal stops collection and clears only the context key.
5. Check DebugView/realtime and then normal reports after their processing delay (custom dimensions may take 24–48 hours). Record release timestamp, article set, windows, exact event definitions, and QA exclusions. Compare article exposures/clicks within matched Search Console queries/countries/devices; do not infer profitability from sessions or installation counts.

```powershell
node --test tests/blog-measurement-contract.test.js tests/google-ads-measurement-contract.test.js tests/product-funnel-analytics.test.js tests/native-ga4-consent-flow.test.js tests/revolut-checkout-reliability.test.js
```

Result on 2026-09-09: **34 passed, 0 failed**, including 11 new blog measurement contracts and 23 existing Ads, native consent, product-funnel, and authoritative checkout contracts. Live post-release verification and all administrative gates above remain pending.

### Broader local verification on 10 September

The complete Node suite was run without loading secrets or changing remote state: **3,929 passed, 3 failed, 3 skipped, 3,935 total**. This is not an all-green full-suite result. The failures are in unchanged files: an Android workflow assertion sensitive to CRLF line endings (its five tests pass when normalising the read in memory), a gateway fixture that overrides `NODE_PATH` and cannot find `express` in this isolated checkout, and an ESM Revolut bootstrap import that cannot resolve `dotenv` through `NODE_PATH`, before configuration or network activity. No unrelated production fix or dependency installation was performed. A complete release run must resolve these environment prerequisites and report fresh results rather than suppressing the failures.

The scoped renderer/measurement/consent/Ads/checkout suite previously passed 48/48. The repeated `--existing-only` build wrote zero article pages; hashes of 120 checked generated/state/calendar files were unchanged. The production publication calendar and state remain untouched. The localhost preview was restarted and its tutorial, source-format table and table-of-contents anchor were checked in the in-app browser; this is preview availability, not a deployed-site or provider-import test.

### Resumption on the later 10 September baseline

The prepared patch was carried into isolated branch `codex/blog-resume-20260910` from `fbb1ba05bda13ac9a13b6f7d504638482bc69555`. The refreshed full suite returned 4,026 passed, 4 failed and 5 skipped out of 4,035; the extra gateway complete-cache fixture failed with HTTP 502. The final focused renderer/blog/funnel suite, including the image-layout regression, passed 31/31. Earlier totals above remain historical, not current acceptance. The seven edited pages, nine referenced images and frozen 117-article publication set are documented in `content/blog/REVIEW-20260910.md`. No GA4 or Ads configuration was changed, no genuine signup/trial/purchase acceptance was executed, and nothing was published.

### Authorized production release — 10 September

The user subsequently requested production publication. A fresh isolated worktree with locked dependencies passed **49/49 focused tests** and **4,030 full-suite tests, zero failures, 10 skips** (4,040 total). See the publication section of `content/blog/REVIEW-20260910.md`. Publication authority covers the prepared code/content and the existing deployment pipeline, not new administrative settings, manual consent/auth decisions or commercial acceptance. The eight custom dimensions and the real consent/auth/checkout reporting checks above remain separate, uncompleted gates. A successful deployment must not be presented as proof that GA4 has received or attributed real business outcomes.
