'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const migration = read('supabase/migrations/20260824130000_provider_access_notification_outbox_v1.sql');
const readinessSmoke = read('supabase/migrations/20260825203000_provider_access_push_readiness_smoke_v1.sql');
const worker = read('supabase/functions/norva-provider-access-notify/index.ts');
const fcm = read('supabase/functions/_shared/fcm.ts');
const android = read('clients/android-phone/app/src/main/java/tv/norva/phone/NorvaMessagingService.java');
const androidManifest = read('clients/android-phone/app/src/main/AndroidManifest.xml');
const edge = read('supabase/functions/norva-provider-access/index.ts');
const app = read('public/js/app.js');
const cloudApi = read('public/js/cloudApi.js');
const api = read('public/js/api.js');
const sourceManager = read('public/js/components/SourceManager.js');
const css = read('public/css/main.css');

test('Provider Access outbox is default-off, per-channel idempotent and private', () => {
  for (const flag of ['provider_access_email_v1_enabled', 'provider_access_push_v1_enabled', 'provider_access_in_app_v1_enabled']) {
    assert.match(migration, new RegExp(`'${flag}', false`));
  }
  assert.match(migration, /unique \(access_cycle_id, event_kind, channel\)/);
  assert.match(migration, /alter table public\.cloud_provider_access_notifications enable row level security/);
  assert.match(migration, /revoke all on table public\.cloud_provider_access_notifications[\s\S]*from public, anon, authenticated/);
  assert.doesNotMatch(
    migration.slice(migration.indexOf('create table'), migration.indexOf('create index')),
    /\n\s+(?:recipient_email|username|password|provider_url|push_token|payload)\s+[a-z]/i,
  );
});

test('claim, final authorization, completion and retry are fenced by the durable lease', () => {
  assert.match(migration, /for update of notification skip locked/);
  assert.match(migration, /lease_sequence = notification\.lease_sequence \+ 1/);
  assert.match(migration, /norva_authorize_provider_access_notification[\s\S]*lease_expires_at > now\(\)/);
  assert.match(migration, /RECIPIENT_CHANGED/);
  assert.match(migration, /transport_started_at = coalesce\(notification\.transport_started_at, now\(\)\)/);
  assert.match(migration, /IDEMPOTENCY_WINDOW_EXPIRED/);
  assert.match(migration, /MAX_ATTEMPTS_EXCEEDED/);
});

test('email transport resolves the current Auth recipient and uses the SQL delivery key', () => {
  assert.match(worker, /admin\.auth\.admin\.getUserById\(userId\)/);
  assert.match(worker, /await authorize\(claimed, "email", worker, resolved\.email\)/);
  assert.match(worker, /"Idempotency-Key": claimed\.delivery_key/);
  assert.match(worker, /RESEND_ACCEPTED/);
  assert.match(worker, /response\.ok && providerId/);
  assert.match(worker, /This reminder concerns access supplied by an external provider/);
  assert.match(worker, /Your Norva plan is not affected/);
  for (const forbidden of ['Renew subscription', 'Pay now', 'Renew now']) assert.doesNotMatch(worker, new RegExp(forbidden, 'i'));
  assert.doesNotMatch(worker, /claimed\.source_name[\s\S]{0,200}(?:subject|html|text|body)/);
});

test('push is data-only, independently durable and deduplicated by a stable row key', () => {
  assert.match(worker, /const emailDrain = RESEND_API_KEY[\s\S]*const pushDrain = fcmConfigured\(\)[\s\S]*Promise\.allSettled\(\[emailDrain, pushDrain\]\)/);
  assert.match(worker, /skipped_not_configured/);
  assert.match(worker, /dataOnly: true/);
  assert.match(worker, /notificationId: claimed\.delivery_key/);
  assert.match(worker, /deepLink: DEEP_LINK/);
  assert.match(worker, /NO_REGISTERED_TOKEN/);
  assert.match(worker, /result\.unregistered[\s\S]*cloud_push_tokens/);
  assert.match(fcm, /msg\.dataOnly[\s\S]*android: \{ priority: "high" \}/);
  assert.match(fcm, /messageId/);
});

test('FCM readiness smoke is explicit, internal-only, revision-bound and does not alter access', () => {
  assert.match(readinessSmoke, /event_kind = 'readiness_smoke' and channel = 'push'/);
  assert.match(readinessSmoke, /readiness_rollout_revision/);
  assert.match(readinessSmoke, /cloud_provider_access_notification_smoke_events/);
  assert.match(readinessSmoke, /cloud_provider_access_rollout_internal_users/);
  assert.match(readinessSmoke, /references public\.cloud_provider_access_notifications\(id\) on delete cascade/);
  assert.match(readinessSmoke, /v_rollout\.revision <> p_expected_rollout_revision/);
  assert.match(readinessSmoke, /norva_provider_access_notification_flag_required\('push'\)/);
  assert.match(readinessSmoke, /provider_access_reminders_enabled\)[\s\S]*readiness_smoke/);
  assert.match(readinessSmoke, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/);
  assert.match(readinessSmoke, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(readinessSmoke, /update public\.cloud_source_provider_access/);
  assert.doesNotMatch(readinessSmoke, /update public\.cloud_source_access_cycles/);
  assert.doesNotMatch(readinessSmoke, /update public\.cloud_sources/);
  assert.match(worker, /case "readiness_smoke"/);
  assert.match(worker, /one-time internal launch check did not change your provider access/);
});

test('Android receives Provider Access in every process state without duplicate trays', () => {
  assert.match(androidManifest, /android:name="\.NorvaMessagingService"[\s\S]*com\.google\.firebase\.MESSAGING_EVENT/);
  assert.doesNotMatch(androidManifest, /com\.google\.firebase\.messaging\.MESSAGING_EVENT/);
  assert.match(android, /"provider_access"\.equals\(data\.get\("kind"\)\)/);
  assert.match(android, /KEY_PROVIDER_ACCESS_SEEN/);
  assert.match(android, /rememberProviderAccessNotification\(notificationId\)/);
  assert.match(android, /MAX_SEEN_PROVIDER_ACCESS = 64/);
  assert.match(android, /PROVIDER_ACCESS_LINK = "https:\/\/norva\.tv\/app\.html\?mobile=1#settings\/sources"/);
  assert.match(android, /new Intent\(Intent\.ACTION_VIEW, deepLink, this, MainActivity\.class\)/);
  assert.match(android, /nm\.notify\(notificationId, b\.build\(\)\)/);
});

test('in-app notifications are owner-scoped, fail-closed and route to Provider Access Settings', () => {
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(migration, /candidate\.user_id = v_user_id/);
  assert.match(migration, /notification\.user_id = v_user_id/);
  assert.match(edge, /matchNotificationRoute/);
  assert.match(edge, /requireInAppNotificationFeatureFlag/);
  assert.match(edge, /norva_list_provider_access_in_app_notifications/);
  assert.match(edge, /norva_dismiss_provider_access_in_app_notification/);
  assert.match(cloudApi, /listNotifications[\s\S]*\/v1\/notifications/);
  assert.match(api, /listNotifications/);
  assert.match(app, /Temporary fetch\/auth\/flag failures must never produce an access/);
  assert.match(app, /this\._settingsSubRoute = 'sources'/);
  assert.match(app, /fullAttention: notifications\[0\]\?\.kind === 'access_hidden' && connectedSourceCount === 1/);
  assert.match(css, /provider-access-in-app-notice\.is-full-attention/);
});

test('the chosen mobile duration layout keeps Duration and Unit on one compact row', () => {
  assert.match(sourceManager, /provider-access-field-row provider-access-duration-row/);
  assert.equal((sourceManager.match(/provider-access-select-shell/g) || []).length >= 2, true);
  assert.equal((sourceManager.match(/provider-access-select-chevron/g) || []).length >= 2, true);
  assert.match(css, /provider-access-field-row\.provider-access-duration-row[\s\S]*grid-template-columns: minmax\(0, 3fr\) minmax\(112px, 2fr\)/);
  assert.match(sourceManager, /aria-haspopup="listbox"/);
  assert.match(sourceManager, /role="option"[\s\S]*aria-selected/);
  assert.match(sourceManager, /select\.hidden = true[\s\S]*trigger\.hidden = false/);
  assert.match(sourceManager, /trigger\.setAttribute\('aria-label', `\$\{fieldLabel\}: \$\{triggerValue\.textContent\}`\)/);
  assert.match(sourceManager, /select\.labels\?\.\[0\]\?\.addEventListener\('click'/);
  assert.match(sourceManager, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(sourceManager, /event\.key === 'Escape'/);
  assert.match(sourceManager, /select\.value === 'skip'[\s\S]*fieldset\.classList\.add\('is-skip-select-open'\)/);
  assert.match(sourceManager, /fieldset\.classList\.remove\('is-skip-select-open'\)/);
  assert.match(css, /provider-access-select-menu[\s\S]*z-index: 10/);
  assert.match(css, /provider-access-terms\.is-skip-select-open[\s\S]*padding-bottom: calc\(132px \+ var\(--space-lg\)\)/);
  assert.match(css, /provider-access-select-option[\s\S]*min-height: 44px/);
  assert.match(css, /provider-access-select-shell\.is-open \.provider-access-select-chevron/);
});

test('duration mode binds an activation date to an interactive accessible calendar', () => {
  assert.match(sourceManager, /Activation or purchase date/);
  assert.match(sourceManager, /data-access-activation-on/);
  assert.match(sourceManager, /providerAccessAddTerm\(startKey, value, unit\)/);
  assert.match(sourceManager, /Math\.min\(start\.getUTCDate\(\), lastDay\)/);
  assert.match(sourceManager, /data-access-calendar-day/);
  assert.match(sourceManager, /termUnit\.value = 'DAY'/);
  assert.match(sourceManager, /provider-access-calendar-timeline/);
  assert.match(sourceManager, /calendar\.classList\.remove\('is-adjusted'\)/);
  assert.match(sourceManager, /requestAnimationFrame\(\(\) => calendar\.classList\.add\('is-adjusted'\)\)/);
  assert.match(sourceManager, /return \{ startedOn, expiresOn: null, termValue, termUnit, remindersEnabled \}/);
  assert.match(css, /provider-access-calendar-day[\s\S]*min-width: 44px;[\s\S]*min-height: 44px/);
  assert.match(css, /provider-access-calendar\.is-adjusted[\s\S]*animation: provider-access-calendar-adjust 260ms/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*provider-access-calendar\.is-adjusted[\s\S]*animation: none/);
});

test('calendar preview clamps month and year terms like PostgreSQL calendar intervals', () => {
  const context = { window: {}, Date, Intl, Set, Map, console };
  vm.runInNewContext(sourceManager, context);
  const manager = Object.create(context.window.SourceManager.prototype);
  assert.equal(manager.providerAccessDateKey(manager.providerAccessAddTerm('2027-01-31', 1, 'MONTH')), '2027-02-28');
  assert.equal(manager.providerAccessDateKey(manager.providerAccessAddTerm('2028-01-31', 1, 'MONTH')), '2028-02-29');
  assert.equal(manager.providerAccessDateKey(manager.providerAccessAddTerm('2028-02-29', 1, 'YEAR')), '2029-02-28');
  assert.equal(manager.providerAccessDateKey(manager.providerAccessAddTerm('2026-08-24', 2, 'MONTH')), '2026-10-24');
});
