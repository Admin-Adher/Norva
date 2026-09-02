'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const app = read('public/js/app.js');
const profiles = read('public/js/profiles.js');
const settings = read('public/js/pages/Settings.js');
const devicesScreens = read('public/js/components/DevicesScreensModule.js');
const standalone = read('public/js/utils/standalone.js');
const phoneMain = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');
const account = read('public/account.html');
const deleteAccount = read('public/delete-account.html');
const norvaModal = read('public/js/components/NorvaModal.js');
const pairTvSheet = read('public/js/components/PairTvSheet.js');
const multiSelect = read('public/js/components/MultiSelect.js');
const sourceManager = read('public/js/components/SourceManager.js');
const mainCss = read('public/css/main.css');

test('every sign-out entry uses the same cancel-first accessible confirmation', () => {
  const navigationModel = read('public/js/navigation/NavigationModel.js');
  assert.match(navigationModel, /key:\s*'logout',[\s\S]{0,180}ariaLabel:\s*'Log out'[\s\S]{0,180}gate:\s*'authenticated'/);
  assert.match(app, /intent\.target === 'logout'[\s\S]{0,100}void this\.signOut\(\)/);
  assert.match(app, /window\.NorvaModal\.confirm\(/);
  assert.match(app, /title:\s*'Log out of Norva\?'/);
  assert.match(app, /confirmLabel:\s*'Log out'/);
  assert.match(app, /cancelLabel:\s*'Stay signed in'/);
  assert.match(app, /if \(!confirmed\) return false/);
  assert.match(settings, /return this\.app\.signOut\(\)/);
});

test('Android phone Back closes searchable region pickers before route navigation', () => {
  assert.match(
    standalone,
    /\[data-region-picker\] \[data-region-pop\]:not\(\[hidden\]\)/,
  );
  assert.match(
    standalone,
    /openRegionPicker\.closest\('\[data-region-picker\]'\)[\s\S]{0,220}picker\.__regionClose\(\)[\s\S]{0,100}return 'handled'/,
  );
  assert.ok(
    standalone.indexOf('const openRegionPicker') < standalone.indexOf('// An open modal'),
    'the phone bridge must consume the picker before generic route/modal fallthrough',
  );
});

test('mobile Account sheet isolates the background, traps focus and restores its exact opener', () => {
  assert.match(app, /aria-labelledby="account-sheet-title"/);
  assert.match(app, /overlay\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(app, /overlay\.setAttribute\('inert', ''\)/);
  assert.match(app, /this\._accountSheetOpener\s*=\s*\(document\.activeElement/);
  assert.match(app, /_setAccountSheetBackgroundInert\(sheet, true\)/);
  assert.match(app, /event\.key === 'GoBack'/);
  assert.match(app, /event\.key !== 'Tab'/);
  assert.match(app, /const target = opener\?\.isConnected \? opener : fallback/);
  assert.match(app, /class="account-close modal-close"/);
  assert.match(standalone, /closeBtn\.click\(\)/);
  assert.doesNotMatch(standalone, /typeof closeBtn\.onclick === 'function'/);
});

test('profile picker and editor expose complete modal, field and selection semantics', () => {
  assert.match(profiles, /overlayEl\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(profiles, /overlayEl\.setAttribute\('aria-labelledby', title\.id\)/);
  assert.match(profiles, /setBackgroundInert\(true\)/);
  assert.match(profiles, /e\.key === 'GoBack'/);
  assert.match(profiles, /e\.key !== 'Tab'/);
  assert.match(profiles, /nameLabel\.htmlFor = nameInput\.id/);
  assert.match(profiles, /choice\.setAttribute\('aria-pressed'/);
  assert.match(profiles, /avatars\.setAttribute\('role', 'group'\)/);
  assert.match(profiles, /card\.setAttribute\('aria-label'/);
  assert.match(profiles, /card\.setAttribute\('aria-current', 'true'\)/);
  assert.doesNotMatch(profiles, /window\.confirm/);
});

test('profile loading failure is explicit, retryable and never exposes provider diagnostics', () => {
  assert.match(profiles, /Profiles are temporarily unavailable/);
  assert.match(profiles, /const retry = el\('button', 'np-btn np-btn-primary', 'Try again'\)/);
  assert.match(profiles, /await promptProfileLoadRetry\('Continue for now'\)/);
  assert.match(profiles, /await promptProfileLoadRetry\('Cancel'\)/);
  assert.match(profiles, /Profiles still could not be loaded\./);
  assert.doesNotMatch(profiles, /setProfileStatus\([^;\n]*(?:e|err|error)\?*\.message/);
});

test('profile deletion is fail-closed and keeps the parent dialog inert while confirming', () => {
  assert.match(profiles, /Confirmation is unavailable\. The profile was not deleted\./);
  assert.match(profiles, /const pendingConfirmation = window\.NorvaModal\.confirm/);
  assert.match(profiles, /overlayEl\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(profiles, /overlayEl\.setAttribute\('inert', ''\)/);
  assert.match(profiles, /cancelLabel:\s*'Keep profile'/);
  assert.match(profiles, /if \(!ok\)[\s\S]{0,100}del\.focus\(\)/);
  assert.doesNotMatch(profiles, /(?:e|err)\?*\.message|\(e && e\.message\)/);
});

test('Settings tabs implement the complete keyboard tab and tabpanel contract', () => {
  assert.match(settings, /tab\.setAttribute\('aria-controls', panel\.id\)/);
  assert.match(settings, /panel\.setAttribute\('role', 'tabpanel'\)/);
  assert.match(settings, /panel\.setAttribute\('aria-labelledby', tab\.id\)/);
  assert.match(settings, /tab\.tabIndex = selected \? 0 : -1/);
  assert.match(settings, /panel\.hidden = !selected/);
  assert.match(settings, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
  assert.match(settings, /this\.switchTab\(next\.dataset\.tab\)/);
});

test('Settings presents sanitized live errors instead of provider payloads', () => {
  const settingsSurfaces = `${settings}\n${devicesScreens}`;
  assert.match(settingsSurfaces, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(devicesScreens, /element\.setAttribute\('role', error \? 'alert' : 'status'\)/);
  assert.doesNotMatch(settingsSurfaces, /textContent\s*=\s*[^;\n]*(?:e|err|error)\?*\.message/);
  assert.doesNotMatch(settingsSurfaces, /NorvaModal\.toast\([^;\n]*(?:e|err|error)\?*\.message/);
  assert.doesNotMatch(settings, /textContent\s*=\s*'Error: '\s*\+\s*data\.error/);
});

test('account entry uses keyboard-complete tabs and live status semantics', () => {
  assert.match(account, /id="tabs" role="tablist" aria-label="Account access"/);
  assert.match(account, /id="signin-tab"[\s\S]{0,160}role="tab" aria-selected="true" aria-controls="signin-form"/);
  assert.match(account, /id="signup-form" role="tabpanel" aria-labelledby="signup-tab" hidden/);
  assert.match(account, /id="status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(account, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(account, /button\.setAttribute\('aria-selected', String\(selected\)\)/);
  assert.match(account, /form\.hidden = !active/);
  assert.ok(account.lastIndexOf('boot();') > account.indexOf('const authTabs'),
    'auth boot must start after the tab contract is initialized');
});

test('account form transitions and native Back preserve a visible focus target', () => {
  assert.match(account, /const activeBefore = document\.activeElement/);
  assert.match(account, /const focusNeedsMove = Boolean\(activeForm && activeForm\[0\] !== name\)/);
  assert.match(account, /recover:\s*'recover-email'/);
  assert.match(account, /password:\s*'new-password'/);
  assert.match(account, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(account, /setSignupPasswordMode\(on\)[\s\S]{0,700}signup-name/);
  assert.match(account, /function dismissAccountDialogForBack\(\)/);
  assert.match(account, /window\.__norvaHandleBack = function \(\)/);
  assert.match(account, /dismissAccountDialogForBack\(\)\) return 'handled'/);
  assert.match(account, /tvBackHost\.handleBack = function \(\)/);
  assert.match(account, /dismissAccountDialogForBack\(\)\) return 'modal'/);
});

test('account deletion announces progress and errors without corrupted copy', () => {
  assert.match(deleteAccount, /id="status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(deleteAccount, /statusEl\.setAttribute\('role', isError \? 'alert' : 'status'\)/);
  assert.match(deleteAccount, /statusEl\.setAttribute\('aria-live', isError \? 'assertive' : 'polite'\)/);
  assert.match(deleteAccount, /Redirecting to sign in…/);
  assert.doesNotMatch(deleteAccount, /Redirecting to sign inâ€¦/);
});

test('source import announces state, bounded progress and terminal errors to assistive technology', () => {
  assert.match(sourceManager, /class="source-sync-announcement"/);
  assert.match(sourceManager, /role="\$\{phase === 'error' \? 'alert' : 'status'\}"/);
  assert.match(sourceManager, /aria-live="\$\{phase === 'error' \? 'assertive' : 'polite'\}"/);
  assert.match(sourceManager, /aria-atomic="true" data-progress-bucket=/);
  assert.match(sourceManager, /querySelector\('\.source-sync-announcement'\)/);
  assert.match(sourceManager, /Number\(announcement\.dataset\.progressBucket\) !== progressBucket/);
  assert.match(sourceManager, /announcement\.textContent = `\$\{sourceName\}\. \$\{phaseLabel\}\./);
  assert.match(mainCss, /\.source-sync-announcement\s*\{[\s\S]{0,260}clip:\s*rect\(0 0 0 0\)/);
});

test('multi-select disclosure semantics match its checkbox group popup', () => {
  assert.match(multiSelect, /this\.btn\.removeAttribute\('aria-haspopup'\)/);
  assert.doesNotMatch(multiSelect, /this\.btn\.setAttribute\('aria-haspopup'/);
  assert.match(multiSelect, /this\.btn\.setAttribute\('aria-controls', this\.panel\.id\)/);
  assert.match(multiSelect, /this\.panel\.setAttribute\('role', 'group'\)/);
  assert.match(multiSelect, /this\.btn\.setAttribute\('aria-expanded', String\(open\)\)/);
});

test('all app-owned modal surfaces isolate the background and warning dialogs share hygiene', () => {
  assert.match(norvaModal, /function isolateBackground\(modalEl\)/);
  assert.match(norvaModal, /element\.inert = true/);
  assert.match(norvaModal, /restoreBackground\(backgroundSnapshot\)/);
  assert.match(sourceManager, /NorvaModal\.installHygiene\(modal,[\s\S]{0,180}onClose: \(\) => finish\(false\)/);
  assert.match(sourceManager, /initialFocus: document\.getElementById\('warning-cancel'\)/);
  assert.match(pairTvSheet, /class="pair-tv-close modal-close"/);
  assert.match(pairTvSheet, /NorvaModal\?\.installHygiene\?\.\(this\.overlay/);
  assert.match(pairTvSheet, /initialFocus: this\.panel/);
  assert.match(pairTvSheet, /overlay\.setAttribute\('inert', ''\)/);
});

test('pairing camera scan stays inside the sheet and the trusted WebView grant', () => {
  assert.match(pairTvSheet, /getUserMedia/);
  assert.match(pairTvSheet, /BarcodeDetector/);
  assert.doesNotMatch(app + settings, /getUserMedia|BarcodeDetector|html5-qrcode/i);
  assert.match(phoneMain, /onPermissionRequest\(PermissionRequest request\)/);
  assert.match(phoneMain, /REQ_CAMERA_PERM/);
  assert.match(phoneMain, /RESOURCE_VIDEO_CAPTURE/);
});
