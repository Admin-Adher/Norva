'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const page = read('public/cloud-pair.html');
const headers = read('public/_headers');

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test('TV pairing keeps the native shell anchors and valid inline JavaScript', () => {
  const ids = [
    'pair-launch-screen',
    'pairing-screen',
    'page-title',
    'page-subtitle',
    'qr',
    'pair-url',
    'code',
    'timer',
    'status',
    'restart-button',
    'account-link'
  ];

  for (const id of ids) {
    assert.equal(occurrences(page, new RegExp(`\\bid=["']${id}["']`, 'g')), 1, `${id} must stay unique`);
  }
  assert.match(page, /tv-pairing-mode/);
  assert.match(page, /tv-pairing-ready/);
  assert.match(page, /class="screen" id="pairing-screen"/);

  const inlineScripts = [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(inlineScripts.length >= 2);
  for (const [, source] of inlineScripts) new vm.Script(source);
});

test('prototype A is a full-bleed split TV layout with a fixed safe action rail', () => {
  assert.match(page, /html\.tv-pairing-mode \.screen \{[\s\S]*?width: 100vw;[\s\S]*?height: 100vh;[\s\S]*?min-height: 0;/);
  assert.match(page, /grid-template-rows: clamp\(40px,[\s\S]*?minmax\(0, 1fr\)[\s\S]*?clamp\(62px,/);
  assert.match(page, /\.pair-main \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) clamp\(270px, 27\.03125vw, 520px\)/);
  assert.match(page, /\.qr-panel \{[\s\S]*?border-left: 1px solid var\(--color-border\)/);
  assert.match(page, /\.qr-shell \{[\s\S]*?width: clamp\(216px, 22\.5vw, 432px\)/);
  assert.match(page, /\.pair-footer \{[\s\S]*?border-top: 1px solid var\(--color-border\)/);
  assert.match(page, /\.btn \{[\s\S]*?min-height: clamp\(48px, 3\.4375vw, 66px\)/);
  assert.doesNotMatch(page, /width:\s*min\(96vw,\s*1160px\)/);
  assert.doesNotMatch(page, /html\.tv-pairing-mode body \{[^}]*padding:\s*clamp\(10px/);
});

test('prototype A copy, hierarchy and real Norva assets remain exact', () => {
  const strings = [
    'TV setup',
    'One minute setup',
    'Connect this TV',
    'to your account.',
    'Scan the QR code with your phone, or enter the pairing code in Norva.',
    'Pairing code',
    'Open Norva',
    'On your phone or tablet',
    'Scan or enter',
    'Use the code shown here',
    'Approve this TV',
    'Watching starts automatically',
    'Scan with your phone camera',
    'No TV keyboard needed.',
    'Approval happens on your phone.',
    'Code is temporary and works only for this TV.',
    'New code',
    'Pair on this TV'
  ];
  for (const copy of strings) assert.ok(page.includes(copy), `missing approved copy: ${copy}`);

  assert.match(page, /\/img\/norva-app-icon-96\.png\?v=1/);
  assert.match(page, /\/img\/icons\/norva-check-circle-simple\.svg\?v=1/);
  assert.match(page, /\/img\/icons\/norva-refresh-simple\.svg\?v=1/);
  assert.match(page, /\/img\/icons\/norva-account\.svg\?v=1/);
  assert.ok(fs.existsSync(path.join(root, 'public/img/icons/norva-refresh-simple.svg')));
  assert.doesNotMatch(page, /iconify|cdn\.tailwindcss|fonts\.googleapis/);
});

test('status is the only pairing live region and reduced motion is respected', () => {
  assert.match(page, /id="status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(page, /class="(?:pair-main|pair-copy|code-row|code|timer|qr-panel|qr-shell)[^"]*"[^>]*aria-live/);
  assert.match(page, /\.btn:focus-visible \{[\s\S]*?outline: 3px solid #bfdbfe;[\s\S]*?outline-offset: 3px/);
  assert.match(page, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(page, /statusEl\.setAttribute\('role', normalizedType === 'error' \? 'alert' : 'status'\)/);
  assert.match(page, /statusEl\.setAttribute\('aria-live', normalizedType === 'error' \? 'assertive' : 'polite'\)/);
  assert.match(page, /timerEl\.textContent = seconds \? `Refreshes in/);
});

test('pair creation is single-flight and the remote skips disabled actions', () => {
  assert.match(page, /let pairingStartPromise = null/);
  assert.match(page, /if \(pairingStartPromise\) return pairingStartPromise/);
  assert.match(page, /restartButton\.disabled = isPending/);
  assert.match(page, /restartButton\.setAttribute\('aria-busy', String\(isPending\)\)/);
  assert.match(page, /qrStateLabelEl\.textContent = 'QR unavailable'/);
  assert.match(page, /timerEl\.textContent = 'Select New code to retry'/);
  assert.match(page, /function remoteItems\(\)[\s\S]*?filter\(\(item\) => item && !item\.disabled && !item\.hidden/);
  assert.match(page, /if \(!isPending && restoreRestartFocus\)[\s\S]*?restartButton\.focus\(\{ preventScroll: true \}\)/);
  assert.match(page, /else if \(!isPending\) \{[\s\S]*?focusInitialRemoteAction\(\)/);
  assert.match(page, /restartButton\.focus\(\{ preventScroll: true \}\)/);
  assert.match(page, /e\.key === 'ArrowRight' \|\| e\.key === 'ArrowDown'/);
  assert.match(page, /e\.key === 'ArrowLeft' \|\| e\.key === 'ArrowUp'/);
  assert.match(page, /e\.key === 'Enter' \|\| e\.key === 'NavigateEnter'/);
});

test('QR fallback and display grouping never change the pairing protocol', () => {
  assert.match(page, /setQrState\('fallback'\)/);
  assert.match(page, /qrShellEl\.hidden = showFallback/);
  assert.match(page, /qrFallbackEl\.hidden = !showFallback/);
  assert.match(page, /qrGuidanceEl\.hidden = showFallback/);
  assert.match(page, /qrPanelEl\.setAttribute\('aria-labelledby', showFallback \? 'qr-fallback-title' : 'qr-caption'\)/);
  assert.match(page, /formatDisplayCode\(currentCode\)/);
  assert.match(page, /currentCode\.split\(''\)\.join\(' '\)/);
  assert.match(page, /NorvaCloud\.pairing\.start\(\{[\s\S]*?ttlSeconds: 600,[\s\S]*?capabilities: \{ cloudPairing: true \}/);
  assert.match(page, /NorvaCloud\.pairing\.poll\(currentCode, currentPairingSecret\)/);
  assert.match(page, /const pairPath = '\/cloud\.html\?pair=' \+ encodeURIComponent\(currentCode\)/);
  assert.match(page, /renderQr\(pairUrl\)/);
  assert.doesNotMatch(page, /renderQr\([^)]*currentPairingSecret/);
  assert.match(page, /pollHandle = setInterval\(pollPairing, 2500\)/);
  assert.match(page, /timerHandle = setInterval\(updateTimer, 1000\)/);
  assert.match(page, /const MAX_AUTO_REGEN = 6/);
});

test('pairing shell is never served stale outside the native cache-busted path', () => {
  assert.match(headers, /\/cloud-pair\.html\s*\r?\n\s+Cache-Control: no-store/);
});
