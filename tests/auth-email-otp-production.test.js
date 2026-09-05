'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('web and Android Phone share one email-first funnel with a real six-digit OTP and optional password', () => {
  const account = read('public/account.html');
  assert.match(account, /android-phone-auth/);
  assert.match(account, /premium-auth-style[^>]*media="not all"/);
  assert.match(account, /if \(isPremiumAuth\)[\s\S]*showForm\('signin'\)/);
  assert.match(account, /function shouldShowWelcome\(\)[\s\S]*if \(!isNativePhoneApp/);
  assert.match(account, /params\.get\('token_hash'\)[\s\S]*params\.get\('mode'\) === 'recovery'[\s\S]*location\.hash/);
  assert.equal((account.match(/<input[^>]+data-otp-digit/g) || []).length, 6);
  assert.match(account, /We’ll email a six-digit code/);
  assert.match(account, /getElementById\('use-password-toggle'\)\.textContent = [^;\r\n]*'Use a password instead'/);
  assert.match(account, /id="create-password-account"[^>]*hidden/);
  assert.match(account, /NorvaAuth\.verifyEmailChallenge\([\s\S]*NorvaAuth\.verifyOtp\(proof\.tokenHash, proof\.verificationType\)/);
  assert.match(account, /id="email-review-form"[\s\S]*No account is created until you enter the code/);
  assert.match(account, /COMMON_EMAIL_DOMAIN_FIXES[\s\S]*'outlook\.cop': 'outlook\.com'/);
  assert.doesNotMatch(account.slice(account.indexOf("trackAuth(opts.signup ? 'signup_started'"), account.indexOf('function sanitizeReturnTo')), /createUser:\s*true/);
});

test('web activates the premium OTP surface while Android TV remains pairing-only', () => {
  const account = read('public/account.html');
  assert.match(account, /id="tabs" role="tablist" aria-label="Account access"[^>]*>/);
  assert.match(account, /document\.documentElement\.classList\.add\('premium-auth'\)/);
  assert.match(account, /if \(!isPremiumAuth\)[\s\S]*email_magic_link/);
  assert.match(account, /tabs\.style\.display = tabsVisible \? 'grid' : 'none'/);
  assert.match(account, /document\.getElementById\('premium-auth-style'\)\.media = 'all'/);
  assert.match(account, /NorvaTV-AndroidTV[\s\S]*cloud-pair\.html/);
});

test('auth API separates typed email OTP verification from token-hash link verification', () => {
  const auth = read('public/js/authApi.js');
  assert.match(auth, /async function verifyEmailOtp\(email, token\)/);
  assert.match(auth, /body:\s*\{ email, token, type: 'email' \}/);
  assert.match(auth, /async function verifyOtp\(tokenHash, type\)/);
  assert.match(auth, /body:\s*\{ type: type \|\| 'recovery', token_hash: tokenHash \}/);
  assert.match(auth, /verifyEmailOtp,/);
  assert.match(auth, /async function requestEmailChallenge/);
  assert.match(auth, /async function verifyEmailChallenge/);
});

test('signed email hook exposes the numeric token only for a marked unified OTP redirect', () => {
  const hook = read('supabase/functions/norva-auth-email/index.ts');
  const signup = hook.slice(hook.indexOf('case "signup"'), hook.indexOf('case "recovery"'));
  const magic = hook.slice(hook.indexOf('case "magiclink"'), hook.indexOf('case "email_change"'));
  for (const block of [signup, magic]) {
    assert.match(block, /code:\s*d\.token/);
    assert.match(block, /cta:\s*\{/);
  }
  assert.match(hook, /client === "unified_email_otp" \|\| client === "android_phone_otp"/);
  assert.match(hook, /Enter this six-digit code on the Norva screen where you started/);
  assert.match(signup, /Confirm your email — Norva/);
  assert.match(magic, /Your sign-in link — Norva/);
});

test('welcome animation is seamless, bounded and has a reduced-motion image fallback', () => {
  const account = read('public/account.html');
  const css = read('public/css/account-premium.css');
  assert.equal((account.match(/data-welcome-slide="[01]"/g) || []).length, 2);
  assert.equal((account.match(/class="welcome-column"/g) || []).length, 6);
  assert.match(css, /\.welcome-reel[\s\S]*height:\s*200%/);
  assert.match(css, /@keyframes norva-poster-rise\s*\{\s*to\s*\{\s*transform:\s*translate3d\(0, -50%, 0\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /norva-auth-poster-wall-motion-1\.webp/);
  assert.match(css, /orientation:\s*landscape[^}]*max-height:\s*520px/);
});

test('approved reassurance copy stays balanced on desktop and compact on mobile', () => {
  const account = read('public/account.html');
  const accountCss = read('public/css/account-premium.css');
  const prototype = read('docs/product/auth-profile-redesign/prototype-archive/l-premium-continuity.html');
  const prototypeCss = read('docs/product/auth-profile-redesign/prototype-archive/prototype.css');
  for (const copy of [
    'One account across phone, web and TV.',
    'Secure code. No password required.',
    'Norva includes no content.',
  ]) {
    assert.match(account, new RegExp(copy.replace(/[.]/g, '\\$&')));
    assert.match(prototype, new RegExp(copy.replace(/[.]/g, '\\$&')));
  }
  assert.match(accountCss, /\.brand > \.signals[\s\S]*grid-template-columns:\s*repeat\(3,/);
  assert.match(prototypeCss, /\.premium-trust[\s\S]*grid-template-columns:\s*repeat\(3,/);
  assert.match(prototype, /class="premium-mobile-trust"/);
  assert.match(prototypeCss, /@media \(max-width: 820px\)[\s\S]*\.premium-mobile-trust\s*\{[\s\S]*display:\s*block/);
});

test('premium profiles reuse production behavior and never introduce a Kids profile', () => {
  const app = read('public/app.html');
  const profiles = read('public/js/profiles.js');
  const css = read('public/css/profiles-premium.css');
  assert.match(app, /\/css\/profiles-premium\.css/);
  assert.match(profiles, /overlayEl\.dataset\.mode = state\.mode \|\| 'select'/);
  assert.match(profiles, /AVATAR_COUNT/);
  assert.doesNotMatch(profiles, /Kids Profile|kids profile/i);
  assert.match(css, /html:not\(\.tv\):not\(\.tv-mode\) body \.np-overlay/);
  assert.match(css, /norva-auth-poster-mosaic-night-premium\.webp/);
});
