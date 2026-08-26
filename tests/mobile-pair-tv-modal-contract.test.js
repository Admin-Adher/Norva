'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const component = read('public/js/components/PairTvSheet.js');
const home = read('public/js/pages/HomePage.js');
const app = read('public/js/app.js');
const appHtml = read('public/app.html');
const css = read('public/css/main.css');

function loadSheet(appStub = {}) {
  const window = {};
  vm.runInNewContext(component, { window, Set, String, Number, Boolean, setTimeout });
  return { window, sheet: new window.PairTvSheet(appStub) };
}

test('Prototype A is shipped as an app-owned bottom sheet with the approved icon', () => {
  assert.ok(fs.existsSync(path.join(root, 'public/img/icons/norva-devices-simple.svg')));
  const icon = read('public/img/icons/norva-devices-simple.svg');
  assert.match(icon, /M18 8V6a2 2 0 0 0-2-2H4/);
  assert.match(icon, /<rect x="16" y="12" width="6" height="10" rx="2"/);

  assert.match(component, /overlay\.className = 'modal-overlay pair-tv-sheet'/);
  assert.match(component, /Pair your TV/);
  assert.match(component, /Open Norva on your TV/);
  assert.match(component, /Scan the QR or enter the 6-character code/);
  assert.match(component, /Manage all devices/);
  assert.match(component, /TV Connected/);
  assert.match(component, /screen is now linked and synced with your account/);
});

test('the phone Home action opens the sheet without changing route', () => {
  const delegatedClick = home.slice(
    home.indexOf("this.container.addEventListener('click'"),
    home.indexOf("this.container.addEventListener('keydown'"),
  );
  assert.match(delegatedClick, /const pairButton = e\.target\.closest\('\[data-ecosystem-pair\]'\)/);
  assert.match(delegatedClick, /openPairTvSheet\?\.\(pairButton\)/);
  assert.doesNotMatch(delegatedClick, /openScreensSettings/);

  assert.match(app, /this\.pairTvSheet = new PairTvSheet\(this\)/);
  assert.match(app, /openPairTvSheet\(opener = null, options = \{\}\)/);
  assert.match(app, /consumePendingPairCode/);
  assert.match(component, /isNativePhoneShell/);
  assert.match(component, /isCloudMode/);
  assert.match(component, /isCatalogReady/);
  assert.match(component, /options\.force === true \|\| options\.code/);

  const modalIndex = appHtml.indexOf('/js/components/NorvaModal.js?v=2');
  const pairIndex = appHtml.indexOf('/js/components/PairTvSheet.js?v=3');
  const homeIndex = appHtml.indexOf('/js/pages/HomePage.js?v=65');
  const appIndex = appHtml.indexOf('/js/app.js?v=1207157791');
  assert.ok(modalIndex > 0 && modalIndex < pairIndex && pairIndex < homeIndex && homeIndex < appIndex);
  assert.match(appHtml, /\/css\/main\.css\?v=119/);
});

test('pairing code normalization matches the six-character TV alphabet exactly', () => {
  const { sheet } = loadSheet();
  assert.equal(sheet.normalizeCode('iO01ab-cd23ZZ'), 'ABCD23');
  assert.equal(sheet.normalizeCode('ghjkmn'), 'GHJKMN');
  assert.equal(sheet.normalizeCode('23456789'), '234567');

  assert.match(component, /PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'/);
  assert.match(component, /maxlength="6"/);
  assert.match(component, /pattern="\[ABCDEFGHJKLMNPQRSTUVWXYZ23456789\]\{6\}"/);
  assert.match(component, /autocomplete="one-time-code"/);
});

test('pairing errors are closed editorial states and never raw provider copy', () => {
  const { sheet } = loadSheet();
  assert.match(sheet.errorMessageForStatus(401), /session has expired/i);
  assert.match(sheet.errorMessageForStatus(402), /device limit/i);
  assert.equal(sheet.errorMessageForStatus(409), sheet.errorMessageForStatus(410));
  assert.match(sheet.errorMessageForStatus(404), /Code not found/);
  assert.match(sheet.errorMessageForStatus(503), /Check your connection/);

  assert.doesNotMatch(component, /(?:textContent|innerHTML)\s*=\s*[^;\n]*(?:error|err|e)\?*\.message/);
  assert.doesNotMatch(component, /JSON\.stringify\(error|error_description|data\.error/);
});

test('submission is single-flight and uses only the existing cloud pairing seam', async () => {
  const { window, sheet } = loadSheet();
  let approveCalls = 0;
  let resolveApproval;
  window.NorvaCloud = {
    pairing: {
      approve(code) {
        approveCalls += 1;
        assert.equal(code, 'ABC234');
        return new Promise(resolve => { resolveApproval = resolve; });
      },
    },
  };

  sheet.input = {
    value: 'abc234',
    readOnly: false,
    removeAttribute() {},
    setAttribute() {},
    focus() {},
    select() {},
  };
  sheet.submitButton = {
    disabled: false,
    textContent: '',
    setAttribute() {},
    removeAttribute() {},
  };
  sheet.errorText = { hidden: true, textContent: '' };
  sheet.liveRegion = { textContent: '', setAttribute() {} };
  sheet.entryState = { hidden: false };
  sheet.successState = { hidden: true, querySelector: () => ({ focus() {} }) };
  sheet.overlay = { classList: { contains: value => value === 'active' } };
  sheet.panel = { setAttribute() {}, removeAttribute() {} };

  const first = sheet.submit();
  const second = await sheet.submit();
  assert.equal(second, false);
  assert.equal(approveCalls, 1);
  assert.equal(sheet.submitButton.disabled, true);

  resolveApproval({ pairing: { internal: 'ignored' }, device: { device_name: 'ignored' } });
  assert.equal(await first, true);
  assert.equal(sheet.entryState.hidden, true);
  assert.equal(sheet.successState.hidden, false);
});

test('sheet focus, Back, IME, safe-area and reduced-motion contracts are explicit', () => {
  assert.match(component, /role="dialog" aria-modal="true"/);
  assert.match(component, /aria-labelledby="pair-tv-title"/);
  assert.match(component, /class="pair-tv-close modal-close"/);
  assert.match(component, /NorvaModal\?\.installHygiene/);
  assert.match(component, /initialFocus: this\.panel/);
  assert.match(component, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(component, /aria-busy/);
  assert.match(component, /setAttribute\('aria-labelledby', 'pair-tv-success-title'\)/);
  assert.match(component, /setAttribute\('aria-labelledby', 'pair-tv-title'\)/);
  assert.match(component, /clearError\(options = \{\}\)[\s\S]{0,420}liveRegion\.textContent = ''/);
  assert.match(component, /overlay\.setAttribute\('inert', ''\)/);
  assert.match(css, /\.pair-tv-panel[\s\S]{0,500}max-height: min\(90dvh, 760px\)/);
  assert.match(css, /var\(--safe-area-inset-bottom\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,140}animation: none/);
  assert.match(css, /\.pair-tv-close[\s\S]{0,100}width: 44px[\s\S]{0,100}height: 44px/);
});

test('a logged-out web QR scan keeps the pair code through account login', () => {
  const appHtml = read('public/app.html');
  const account = read('public/account.html');
  assert.match(appHtml, /var pairingReturn = \/\[\?&\]pair=\[A-Za-z0-9\]\+\//);
  assert.match(appHtml, /nativeApp \|\| pairingReturn/);
  assert.match(account, /norva-post-login-return/);
  assert.match(account, /sanitizeReturnTo\(rawReturnTo\) \|\| sanitizeReturnTo\(storedReturnTo\)/);
});

test('QR and Settings open the in-app sheet instead of a standalone pairing page', () => {
  const settings = read('public/js/pages/Settings.js');
  const cloudPair = read('public/cloud-pair.html');
  const cloud = read('public/cloud.html');
  const pairApprove = read('public/pair-approve.html');
  const account = read('public/account.html');

  assert.match(settings, /openPairTvSheet\?\.\(event\.currentTarget, \{ force: true \}\)/);
  assert.doesNotMatch(settings, /approvePairCode/);
  assert.match(cloudPair, /\/app\.html\?pair=/);
  assert.match(cloud, /location\.replace\('\/app\.html\?pair='/);
  assert.match(pairApprove, /location\.replace\('\/app\.html\?pair='/);
  assert.match(account, /\/app\.html\?pair=\$\{encodeURIComponent\(pair\)\}#home/);
});

test('the sheet can scan a TV QR into the existing approve seam', () => {
  const { sheet } = loadSheet();
  assert.equal(sheet.codeFromScanPayload('https://norva.tv/app.html?pair=ABC234#home'), 'ABC234');
  assert.equal(sheet.codeFromScanPayload('abc234'), 'ABC234');
  assert.match(component, /BarcodeDetector/);
  assert.match(component, /getUserMedia/);
  assert.match(component, /facingMode/);
  assert.match(component, /NorvaCloud\?\.pairing\?\.approve/);
  assert.doesNotMatch(component, /\/api\/pair\/approve|html5-qrcode|fetch\(/);
});
