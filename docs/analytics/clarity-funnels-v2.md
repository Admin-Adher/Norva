# Norva Clarity funnel operating system v2

Status: implementation contract for PR #276. Production activation stays gated
by the active Provider Access rollout observation.

## Purpose

Clarity is the qualitative diagnosis layer for Norva. It answers where a
journey breaks, on which surface, and what the user experienced immediately
before the break. Billing truth, entitlement truth and operational SLOs remain
server-side; Clarity must never be treated as the authoritative payment or
rollout ledger.

The same event spine is used across browser, Android phone/tablet and Android
TV. Each platform keeps a separate Clarity project, then uses the same names,
dimensions and funnel definitions so results can be compared without mixing
capture policies.

## Privacy contract

Never send an email, account/user/source/provider/title/order/payment ID,
credential, URL, search query, free-text error, media title or playlist name.
Do not call Clarity Identify. Every event name and context value is selected
from a closed allowlist. WebView content, account/setup screens and native
player roots stay masked. Collection remains consent-gated.

## Twenty-event Smart Event spine

Clarity permits twenty custom Smart Events per project. Configure exactly this
reusable spine in all three projects:

1. `app_open`
2. `primary_cta_clicked`
3. `signup_started`
4. `signup_completed`
5. `plan_selected`
6. `checkout_started`
7. `checkout_completed`
8. `provider_connect_started`
9. `provider_connected`
10. `provider_access_saved`
11. `provider_action_required`
12. `provider_repair_started`
13. `provider_repair_succeeded`
14. `catalog_sync_started`
15. `catalog_ready`
16. `content_opened`
17. `playback_started`
18. `playback_first_frame`
19. `journey_retry`
20. `journey_error`

Supporting API events such as `landing_view`, `store_cta_clicked`,
`login_started`, `login_completed`, `pricing_viewed`,
`billing_period_changed`, `faq_opened`, `demo_interaction` and the context
widget events remain queryable without consuming a Smart Event slot.

## Standard dimensions

Use these as dashboard filters and saved segments. Values are bounded in code.

| Dimension | Purpose |
|---|---|
| `norva_platform` | `web`, `mobile`, `tv` |
| `norva_runtime` | browser, Android WebView or native |
| `norva_surface` / `norva_screen` | page and bounded screen name |
| `norva_app_version` | native release comparison |
| `release_channel` | production, QA or preview |
| `funnel_version` | excludes incompatible historical instrumentation |
| `visitor_state` | signed-in versus anonymous, never identity |
| `billing_period` / `selected_plan` | commercial choice |
| `journey_entrypoint` | origin of the journey |
| `journey_name` / `journey_step` / `journey_outcome` | diagnostic spine |
| `failure_family` | bounded cause family, never raw errors |
| `catalog_state` / `provider_access_state` | product readiness state |
| `last_product_event` | last accepted event before replay/friction |

Default every saved production view to `release_channel=production` and the
current `funnel_version`. Create separate QA views; never mix localhost or
preview sessions into commercial decisions.

## Funnels to configure

All percentages use unique sessions in a fixed date range. Compare like-for-
like platform, release and consent cohorts.

### F1 — Web acquisition

`landing_view` -> `primary_cta_clicked` -> `signup_started` ->
`signup_completed`

Primary KPI: completed signups / production landing sessions. Diagnose by
viewport, CTA source, auth method and journey outcome.

### F2 — Paid conversion

`pricing_viewed` -> `plan_selected` -> `checkout_started` ->
`checkout_completed`

Primary KPI: confirmed checkouts / pricing sessions. Diagnose by plan, billing
period, entrypoint and failure family. A checkout completion is emitted only
after authoritative confirmation; opening the payment widget is not success.

### F3 — Provider onboarding

`provider_connect_started` -> `provider_connected` ->
`provider_access_saved` -> `catalog_sync_started` -> `catalog_ready`

Primary KPI: ready catalogues / provider journeys started. Split by platform,
entrypoint and final journey outcome. Do not add provider names as dimensions.

### F4 — Time to first value

`app_open` -> `content_opened` -> `playback_started` ->
`playback_first_frame`

Primary KPI: first frames / app opens. The final step requires rendered-frame
evidence, not merely a play request. Diagnose phone/TV/Web separately.

### F5 — Provider recovery

`provider_action_required` -> `provider_repair_started` ->
`provider_repair_succeeded` -> `catalog_ready`

Primary KPI: restored catalogues / action-required sessions. Split by
`failure_family` and `provider_access_state`; 401/403/404 remain action-required
states and must not be labelled as confirmed expiry without user evidence.

### F6 — Store intent

`landing_view` -> `store_cta_clicked`

Create separate filtered views for `event_target=android_mobile` and
`event_target=android_tv`. Clarity measures outbound intent, not Play Store
install or activation. Join install-referrer / Play Console or a consented
mobile acquisition source outside Clarity for the post-click steps.

### F7 — Authentication reliability

`signup_started` -> `signup_completed` and, separately,
`login_started` -> `login_completed`

Split by `auth_method`. Use `journey_error` filtered to
`journey_name=authentication` as the failure companion chart.

### F8 — Retry effectiveness

`journey_error` -> `journey_retry` -> the relevant terminal success event
(`catalog_ready`, `provider_repair_succeeded` or `playback_first_frame`).

Keep separate saved funnels per journey; do not combine terminal successes in
one funnel because Clarity funnel steps are ordered predicates, not OR groups.

## Executive scorecard

| KPI | Formula | Initial investigation trigger | Owner |
|---|---|---|---|
| Signup completion | `signup_completed / signup_started` | drop >=15 points versus trailing 7-day comparable baseline, >=30 starts | Growth + Product |
| Checkout completion | `checkout_completed / checkout_started` | <75% or drop >=10 points, >=20 starts | Commerce |
| Provider ready rate | `catalog_ready / provider_connect_started` | <85% after 24 h, >=20 starts | Provider Access |
| First-frame rate | `playback_first_frame / playback_started` | <95% or error >5%, >=50 starts | Playback |
| Recovery success | `provider_repair_succeeded / provider_repair_started` | <80%, >=15 starts | Provider Access |
| Retry recovery | success after retry / `journey_retry` | <70%, >=15 retries | Journey owner |
| Rage/dead/error click rate | affected sessions / production sessions | >=2x 7-day baseline and >=10 sessions | Web/Product |
| LCP / INP / CLS | production p75 by page and viewport | Core Web Vitals poor threshold with >=30 page views | Web Performance |

These thresholds are provisional. Do not alert or change product behavior from
the current two-session sample. Rebaseline after at least fourteen normal days
or 500 production sessions, whichever comes later.

## Rapid response playbook

1. Confirm sample size, production release and funnel version.
2. Locate the first step with abnormal conversion loss.
3. Compare platform, viewport/app version, entrypoint and auth/billing choice.
4. Filter `journey_error` by journey/step/failure family.
5. Open only consented masked recordings for affected sessions; check rage,
   dead and excessive scrolling signals plus the last accepted product event.
6. Correlate with authoritative backend metrics before declaring root cause.
7. Assign an owner and annotate the release/fix time. Compare the same segment
   before/after; do not change the funnel definition during that comparison.
8. Escalate payment, P0, Provider Access rollout or data-integrity anomalies to
   their fail-closed operational runbooks instead of treating Clarity as truth.

## Saved views and watchlist

Create these views in each relevant project:

- Production overview (current funnel version)
- Mobile browser, desktop browser and tablet browser
- Android phone native/WebView and Android TV native/WebView
- Anonymous acquisition and signed-in activation
- Signup by email/password, magic link and Google
- Monthly versus annual; Plus versus Family
- Provider onboarding, recovery and catalog-sync errors
- Playback failures, retries and no-first-frame sessions
- New release versus previous release
- Rage clicks, dead clicks, excessive scrolling, quick backs and JavaScript
  errors, filtered to production

Watchlist order: checkout completion, provider ready rate, first-frame rate,
journey errors, recovery success, Core Web Vitals, rage/dead/error clicks.

## Live Web project configuration (2026-08-28)

The production Web project `y8fgihobbx` currently has two page-visit funnels
that can operate before the v2 API events are deployed:

- `Acquisition Web - Landing vers App`: landing -> account -> offer ->
  checkout -> app.
- `Activation Web - Provider vers lecture`: Settings/Sources -> Home ->
  Movies or Series -> Watch.

The following production-only segments are saved and pinned to the personal
watchlist:

- `Production Web - norva.tv uniquement`
- `Alerte - Erreurs JavaScript production`
- `Alerte - Performance Web pauvre`
- `Alerte - Clics non valides production`
- `Alerte - Clics de colère production`
- `Alerte - Défilement excessif production`
- `Alerte - Retours rapides production`

Three production-only comparison cohorts are also saved, without adding noise
to the alert watchlist:

- `Production Web - Mobile`
- `Production Web - Tablette`
- `Production Web - Bureau`

The production segment filters URLs to `https://norva.tv/` and therefore
excludes localhost and preview traffic. The current sample is too small to set
or evaluate a commercial baseline. Do not interpret a zero conversion rate as
a defect until the minimum sample conditions in the executive scorecard are
met.

Clarity exposes API events as selectable Smart Events only after each event has
been received at least once. Create the eight event funnels above after the
first genuine, consented v2 production signals arrive. Do not generate a
synthetic public session to unlock the selectors.

## Configuration and validation gate

1. Create the twenty Smart Events from the matching API event names in all
   three projects after the first genuine event is received.
2. Create F1-F8 and the saved production segments above.
3. Verify each funnel with a real consented QA journey; never fabricate public
   production traffic.
4. Confirm forbidden values are absent from tags, event names and recordings.
5. Confirm strict masking and capture limits for both Android projects.
6. Confirm dashboards exclude localhost/preview and show platform/release.
7. Publish Android only after Data Safety, privacy disclosure, CI, emulator and
   physical validation gates are complete.

Cross-project user journeys cannot be joined reliably inside Clarity because
Norva intentionally sends no cross-platform identity. Use aggregate campaign
and install attribution outside Clarity, while Clarity remains the in-surface
friction and replay layer.
