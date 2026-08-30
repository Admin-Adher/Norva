'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8').replace(/\r\n/g, '\n');
const overviewStart = source.indexOf('    async _loadMarketingOverview()');
const overviewEnd = source.indexOf('    static AUDIENCES()', overviewStart);
const overview = source.slice(overviewStart, overviewEnd);
const pageStart = source.indexOf('    async _pageMarketing()');
const pageEnd = source.indexOf('    async _loadMarketingOverview()', pageStart);
const page = source.slice(pageStart, pageEnd);

test('Marketing overview implements the approved action-centre hierarchy with real data', () => {
  assert.match(page, /Centre marketing[\s\S]*Décider, préparer, diffuser/);
  assert.match(page, /Programmer un push[\s\S]*Créer une campagne/);
  for (const label of [
    'À faire maintenant',
    'Diffusions et automations',
    'Activité récente',
    'Prochaine diffusion',
    'État des canaux',
  ]) assert.match(overview, new RegExp(label));
  assert.match(overview, /admin_marketing_overview/);
  assert.match(overview, /admin_billing_prices/);
  assert.match(overview, /admin_promo_campaign/);
  assert.match(overview, /this\._notificationOverview/);
  assert.match(overview, /this\._notificationSchedules/);
  assert.match(overview, /this\._notificationRules/);
  assert.match(overview, /this\._notificationSystemRules/);
  assert.doesNotMatch(overview, /<canvas|<svg[^>]+chart|funnel|sparkline/i);
});

test('overview actions open the existing operational workspaces instead of mock controls', () => {
  assert.match(page, /data-mkt-action="schedule"/);
  assert.match(page, /openNotificationWorkspace\('composer', true\)/);
  assert.match(page, /data-mkt-action="campaign"/);
  assert.match(overview, /data-overview-notif="automations"/);
  assert.match(overview, /data-overview-notif="history"/);
  assert.match(overview, /data-overview-goto="\$\{task\.goto\}"/);
  assert.match(overview, /this\._renderNotificationCenter\(\)/);
});

test('command-centre styles are restrained, responsive and touch accessible', () => {
  assert.match(source, /\.mkt-command-button\{[^}]*min-height:44px/);
  assert.match(source, /\.mkt-command-row-action\{[^}]*min-height:44px/);
  assert.match(source, /@media\(max-width:760px\)[^{]*\{[^}]*\.mkt-command-head/);
  assert.match(source, /@media\(max-width:520px\)/);
  const cssStart = source.indexOf('#page-admin .mkt-command-page');
  const cssEnd = source.indexOf('#page-admin .promo-workspace', cssStart);
  const css = source.slice(cssStart, cssEnd);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient/);
  assert.match(css, /var\(--adm-blue\)/);
  assert.match(css, /focus-visible/);
});

test('mobile Admin navigation is a labelled drawer with backdrop, focus return and Back handling', () => {
  assert.match(source, /id="crm-sidebar" aria-label="Navigation de l’administration"/);
  assert.match(source, /class="crm-menu-toggle"[^>]*aria-controls="crm-sidebar"[^>]*aria-expanded="false"/);
  assert.match(source, /class="crm-sidebar-backdrop"[^>]*aria-label="Fermer la navigation"/);
  assert.match(source, /adminSidebar\.inert = mobile && !visible/);
  assert.match(source, /adminMain\) adminMain\.inert = false/);
  assert.match(source, /adminMain\) adminMain\.inert = true/);
  assert.match(source, /\['Escape', 'GoBack', 'BrowserBack'\]/);
  assert.match(source, /@media\(max-width:900px\)[\s\S]*\.crm-sidebar\{position:fixed[\s\S]*transform:translateX/);
  assert.match(source, /prefers-reduced-motion:reduce\)\{#page-admin \.crm-toast,[^\n]*#page-admin \.crm-sidebar/);
});
