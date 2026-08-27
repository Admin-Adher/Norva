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
  assert.match(sourceManager, /modal\.classList\.add\('provider-access-wizard-modal'\);[\s\S]{0,80}footer\.hidden = true/);
  assert.match(sourceManager, /norva:provider-access-complete'[\s\S]{0,180}modal-save/);
  assert.doesNotMatch(sourceManager, /API\.(?:notifications|push).*reminder|enqueue.*reminder/i);
});

test('Add TV provider makes connection step one and access choice step two', () => {
  assert.match(sourceManager, /data-source-provider-onboarding/);
  assert.match(sourceManager, /data-source-connection-step[\s\S]{0,900}Step 1 of \$\{initialTotal\}[\s\S]{0,900}Add your TV provider/);
  assert.match(sourceManager, /\$\{urlField\}[\s\S]{0,180}source-provider-login-separator[\s\S]{0,180}\$\{manualLogin\}[\s\S]{0,120}\$\{nameField\}/);
  assert.match(sourceManager, /source-provider-manual-login[\s\S]{0,180}Enter server login manually/);
  assert.match(sourceManager, /source-access-onboarding'[\s\S]{0,120}deferred: true, stepOffset: 1/);
  assert.match(sourceManager, /data-access-step-offset="\$\{normalizedStepOffset\}"/);
  assert.match(sourceManager, /const visibleStep = stepOffset \+ stepIndex \+ 1/);
  assert.match(sourceManager, /const showSourceAccessStep = \(\) => \{[\s\S]+?accessWizard\.showStep\(0\)/);
  assert.match(sourceManager, /norva:provider-access-cancel'[\s\S]{0,180}showSourceConnectionStep/);
  assert.match(css, /\.source-provider-login-separator\s*\{[\s\S]{0,220}grid-template-columns/);
  assert.match(css, /\.source-provider-manual-login summary\s*\{[\s\S]{0,80}color:\s*var\(--color-text-primary\)/);
  assert.match(css, /\.provider-access-wizard-modal \.source-provider-onboarding > \.provider-access-terms\s*\{[\s\S]{0,280}border:\s*0;[\s\S]{0,100}background:\s*transparent;[\s\S]{0,80}box-shadow:\s*none/);
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

test('Settings separates access dates, candidate login and replacement paths without a credential PATCH', () => {
  assert.match(sourceManager, /Manage provider access/);
  assert.match(sourceManager, /Repair or change login/);
  assert.match(sourceManager, /Change provider or catalogue/);
  assert.match(sourceManager, /intent: 'credentials'/);
  assert.match(sourceManager, /intent: 'provider'/);
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

test('source actions group Provider Access by period, login and catalogue intent', () => {
  assert.match(
    sourceManager,
    /role="group" aria-label="Provider access"[\s\S]*Manage provider access[\s\S]*Dates, duration and reminders[\s\S]*Repair or change login[\s\S]*Change provider or catalogue/,
  );
  assert.match(
    sourceManager,
    /Provider access[\s\S]*Catalog actions[\s\S]*Service[\s\S]*Danger zone/,
  );
  assert.doesNotMatch(sourceManager, /Login or catalogue changed\?/);
  assert.match(sourceManager, /needsRepair && type === 'xtream' && !providerAccessEnabled[\s\S]{0,160}Check service/);
  assert.match(sourceManager, /type !== 'xtream'[\s\S]{0,180}data-action="edit"/);
  assert.match(css, /\.source-menu-item\s*\{[\s\S]{0,160}min-height:\s*44px/);
  assert.match(css, /\.source-menu-item:focus-visible\s*\{[\s\S]{0,160}box-shadow:\s*inset 0 0 0 2px var\(--color-accent\)/);
  assert.match(sourceManager, /ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/);
  assert.match(sourceManager, /Escape[\s\S]{0,180}restoreFocus:\s*true/);
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

test('Provider Access wizard uses adaptive height, one scroller and non-obscuring actions', () => {
  assert.match(css, /\.provider-access-wizard-modal \.modal-content\s*\{[\s\S]{0,180}height:\s*auto/);
  assert.match(css, /\.provider-access-wizard-modal \.modal-body\s*\{[\s\S]{0,220}overflow-y:\s*auto/);
  assert.match(css, /\.provider-access-wizard-modal \.provider-access-terms\s*\{[\s\S]{0,220}overflow:\s*visible/);
  assert.match(css, /\.provider-access-wizard-modal \.provider-access-wizard-stage\s*\{[\s\S]{0,220}overflow:\s*visible/);
  assert.match(css, /\.provider-access-wizard-modal \.provider-access-wizard-actions\s*\{[\s\S]{0,100}position:\s*static/);
  assert.match(css, /\.provider-access-wizard-modal \.modal-footer\s*\{[\s\S]{0,80}display:\s*none/);
  assert.match(sourceManager, /modalBody\?\.closest\('\.provider-access-wizard-modal'\)[\s\S]{0,80}modalBody\.scrollTop = 0/);
});

test('Provider Access keeps the exact-date calendar optional and explains paused services', () => {
  assert.match(sourceManager, /<details class="provider-access-calendar" data-access-calendar>/);
  assert.match(sourceManager, /Calculated end date/);
  assert.match(sourceManager, /Adjust date/);
  assert.match(sourceManager, /will then record the period in days/);
  assert.match(sourceManager, /Recording an access period will not enable this service/);
  assert.match(sourceManager, /new Intl\.DateTimeFormat\('en'/);
  assert.match(css, /\.provider-access-calendar > summary\s*\{[\s\S]{0,120}min-height:\s*44px/);
});

test('all changed Provider Access UI assets are cache-busted', () => {
  assert.match(shell, /main\.css\?v=ee4d1292b9/);
  assert.match(shell, /cloudApi\.js\?v=70/);
  assert.match(shell, /api\.js\?v=89/);
  assert.match(shell, /sourceHealth\.js\?v=6c0eefcb4f/);
  assert.match(shell, /SourceManager\.js\?v=dedefaf3cf/);
  assert.match(shell, /HomePage\.js\?v=6016cf63fb/);
});
