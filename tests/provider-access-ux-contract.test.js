'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const cloudApi = read('public/js/cloudApi.js');
const api = read('public/js/api.js');
const sourceManager = read('public/js/components/SourceManager.js');
const home = read('public/js/pages/HomePage.js');
const css = read('public/css/main.css');
const shell = read('public/app.html');
const config = read('public/js/provider-access-config.js');
const lifecycle = read('supabase/migrations/20260824120000_provider_access_cycles_detection_v1.sql');
const calendarTerms = read('supabase/migrations/20260824120200_provider_access_calendar_terms_v1.sql');

test('Provider Access UI has an independent default-off rollout gate', () => {
  assert.match(config, /NORVA_PROVIDER_ACCESS_UI_V1 = window\.NORVA_PROVIDER_ACCESS_UI_V1 === true/);
  assert.match(sourceManager, /window\.NORVA_PROVIDER_ACCESS_UI_V1 === true/);
  assert.match(sourceManager, /API\?\.providerAccess\?\.available/);
  assert.match(shell, /provider-access-config\.js\?v=1/);
});

test('browser calls the dedicated v1 Edge contract with exact mutation preconditions', () => {
  assert.match(cloudApi, /DEFAULT_PROVIDER_ACCESS_URL = 'https:\/\/api\.norva\.tv\/functions\/v1\/norva-provider-access'/);
  assert.match(cloudApi, /Norva-Contract-Version.*provider-access\.norva\/v1/s);
  assert.match(cloudApi, /headers\['Idempotency-Key'\]/);
  assert.match(cloudApi, /headers\['If-Match'\]/);
  for (const pathPart of ['access/cycles', 'credential-candidates', 'replacements']) {
    assert.match(cloudApi, new RegExp(pathPart));
  }
  assert.match(api, /providerAccess:[\s\S]*resolveSourceId/);
  assert.doesNotMatch(cloudApi, /deviceToken[\s\S]{0,120}providerAccessRequest/);
});

test('onboarding collects an optional duration or explicit dates plus reminder opt-in', () => {
  assert.match(home, /getProviderAccessTermsFields.*home-provider-access[\s\S]{0,120}onboarding: true, deferred: true/);
  assert.match(home, /readProviderAccessTerms\(form\)/);
  assert.match(sourceManager, /Duration bought/);
  assert.match(sourceManager, /Start and end dates/);
  assert.match(sourceManager, /Remind me before it ends/);
  assert.match(sourceManager, /data-access-reminders\$\{reminders \? ' checked' : ''\}/);
  assert.doesNotMatch(sourceManager, /data-access-reminders checked/);
  assert.match(home, /payload\.type === 'xtream'/);
  assert.match(home, /data-setup-flow-step="connection"/);
  assert.match(home, /setFlowStep\('access'\)/);
  assert.match(home, /submit\.hidden = accessActive;[\s\S]{0,80}submit\.classList\.toggle\('hidden', accessActive\)/);
  assert.match(home, /norva:provider-access-complete/);
  assert.match(home, /accessWizardApproved = true[\s\S]{0,80}form\.requestSubmit\(\)/);
  assert.match(home, /if \(needsAccessStep && !accessWizardApproved\)/);
  assert.match(sourceManager, /const initialMode = cycle\?\.termValue \? 'duration' : \(access\?\.expiresOn \? 'dates' : 'duration'\)/);
  assert.match(sourceManager, /document\.getElementById\('modal-save'\)\.hidden = true/);
  assert.match(sourceManager, /norva:provider-access-complete'[\s\S]{0,180}modal-save/);
  assert.doesNotMatch(sourceManager, /API\.(?:notifications|push).*reminder|enqueue.*reminder/i);
});

test('Settings provider label cannot inherit personal account autofill', () => {
  assert.match(sourceManager, /id="source-name"[^>]*name="provider-display-name"/);
  assert.match(sourceManager, /id="source-name"[^>]*autocomplete="off"/);
  assert.match(sourceManager, /id="source-name"[^>]*autocapitalize="words"/);
  assert.match(sourceManager, /id="source-name"[^>]*spellcheck="false"/);
  assert.match(sourceManager, /id="source-username"[^>]*name="provider-login"[^>]*autocomplete="off"[^>]*autocapitalize="none"[^>]*spellcheck="false"/);
  assert.match(sourceManager, /id="source-password"[^>]*name="provider-secret"[^>]*autocomplete="new-password"/);
  assert.doesNotMatch(sourceManager, /id="source-username"[^>]*autocomplete="username"/);
  assert.doesNotMatch(sourceManager, /id="source-password"[^>]*autocomplete="current-password"/);
});

test('calendar durations are resolved server-side and cannot be mixed with an explicit end date', () => {
  // Calendar authority was moved to a forward-only migration so an already
  // applied 1200 migration is never silently rewritten.
  assert.doesNotMatch(lifecycle, /p_expires_on is not null and p_term_value is not null/);
  assert.match(calendarTerms, /p_expires_on is not null and p_term_value is not null/);
  assert.match(calendarTerms, /when 'month' then \(v_started_on \+ make_interval\(months => p_term_value\)\)::date/);
  assert.match(calendarTerms, /when 'year' then \(v_started_on \+ make_interval\(years => p_term_value\)\)::date/);
  assert.match(calendarTerms, /provider_access_expires_on = v_expires_on/);
});

test('Settings exposes renewal, candidate login and replacement paths without a credential PATCH', () => {
  assert.match(sourceManager, /Provider renewed the same login/);
  assert.match(sourceManager, /I received new login details/);
  assert.match(sourceManager, /I changed provider or catalogue/);
  assert.match(sourceManager, /API\.providerAccess\.createCandidate/);
  assert.match(sourceManager, /API\.providerAccess\.decideCandidate/);
  assert.match(sourceManager, /API\.providerAccess\.applyCandidate/);
  assert.match(sourceManager, /API\.providerAccess\.createReplacement/);
  assert.match(sourceManager, /API\.providerAccess\.promoteReplacement/);
  assert.match(sourceManager, /if \(type === 'xtream' && form\.credentialsProvided && this\.providerAccessUiEnabled\(\)\)/);
  assert.match(sourceManager, /form\.credentialsProvided && !this\.providerAccessUiEnabled\(\)[\s\S]{0,260}saved login was not changed/);
  assert.match(sourceManager, /await API\.sources\.update\(id, \{ displayName: name \}\)/);
  assert.doesNotMatch(sourceManager, /data\.(?:username|password)\s*=/);
  assert.doesNotMatch(sourceManager, /API\.sources\.update\(id, \{[^}]*password/s);
});

test('onboarding reports Provider Access validation separately from login errors', () => {
  assert.match(home, /\^Enter a valid provider access /);
  assert.match(home, /querySelector\('\[data-access-error\]'\)/);
  assert.match(home, /target\?\.setAttribute\('aria-invalid', 'true'\)/);
  assert.match(home, /showSummaryError\(message\)/);
});

test('ambiguous, stale, loading, retry, terminal and rollback states have explicit accessible UI', () => {
  assert.match(sourceManager, /These details are for the same catalogue/);
  assert.match(sourceManager, /This is a different provider or catalogue/);
  assert.match(sourceManager, /role="status" aria-live="polite"/);
  assert.match(sourceManager, /role="alert"/);
  assert.match(sourceManager, /button,select,input.*disabled = busy/s);
  assert.match(sourceManager, /TRANSITION_REVISION_MISMATCH/);
  assert.match(sourceManager, /Restore previous catalogue/);
  assert.match(sourceManager, /previous login and catalogue remain authoritative/);
});

test('Provider Access controls use Norva tokens and remain touch, mobile and motion safe', () => {
  const providerCss = css.slice(
    css.indexOf('/* Provider Access lifecycle'),
    css.indexOf('.source-sync-announcement', css.indexOf('/* Provider Access lifecycle'))
  );
  assert.match(css, /\.provider-access-path\s*\{[\s\S]*min-height:\s*54px/);
  assert.match(css, /\.provider-access-actions \.btn,[\s\S]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 640px\)[\s\S]*provider-access-field-row[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation:\s*none/);
  assert.doesNotMatch(providerCss, /#[0-9a-f]{3,8}/i);
  assert.match(css, /html\.tv-mode #page-settings \.settings-source-management[\s\S]{0,80}display:\s*none/);
});

test('Provider Access wizard has one vertical scroller and one action footer', () => {
  assert.match(css, /\.provider-access-wizard-modal \.modal-body\s*\{[\s\S]{0,220}overflow-y:\s*auto/);
  assert.match(css, /\.provider-access-wizard-modal \.provider-access-terms\s*\{[\s\S]{0,220}overflow:\s*visible/);
  assert.match(css, /\.provider-access-wizard-modal \.provider-access-wizard-stage\s*\{[\s\S]{0,220}overflow:\s*visible/);
  assert.match(css, /\.provider-access-wizard-modal \.provider-access-wizard-actions\s*\{[\s\S]{0,100}position:\s*sticky[\s\S]{0,80}bottom:\s*0/);
  assert.match(css, /\.provider-access-wizard-modal \.modal-footer\s*\{[\s\S]{0,80}display:\s*none/);
  assert.match(sourceManager, /modalBody\?\.closest\('\.provider-access-wizard-modal'\)[\s\S]{0,80}modalBody\.scrollTop = 0/);
});

test('all changed Provider Access UI assets are cache-busted', () => {
  assert.match(shell, /main\.css\?v=121/);
  assert.match(shell, /cloudApi\.js\?v=70/);
  assert.match(shell, /api\.js\?v=89/);
  assert.match(shell, /SourceManager\.js\?v=49/);
  assert.match(shell, /HomePage\.js\?v=e235acfa42/);
});
