'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function method(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing method: ${signature}`);
  const open = source.indexOf('{', start);
  assert.ok(open >= 0, `missing method body: ${signature}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated method: ${signature}`);
}

const manifest = read('clients/android-phone/app/src/main/AndroidManifest.xml');
const main = read('clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java');

test('phone declares a verified HTTPS /r/* App Link without changing pairing or title links', () => {
  assert.match(
    manifest,
    /<intent-filter android:autoVerify="true">[\s\S]*?<data android:scheme="https" android:host="norva\.tv" android:pathPrefix="\/r\/" \/>[\s\S]*?<\/intent-filter>/,
  );
  assert.match(manifest, /android:scheme="norva" android:host="pair"/);
  assert.match(manifest, /android:pathPrefix="\/t\/"/);
  assert.match(manifest, /android:launchMode="singleTop"/);
});

test('cold and warm referral intents load one canonical bounded WebView URL', () => {
  const deepLink = method(main, 'private boolean handleDeepLink(Intent intent)');
  const destination = method(
    main,
    'private static String referralAppLinkDestination(Uri data)',
  );
  const warm = method(main, 'protected void onNewIntent(Intent intent)');

  assert.match(deepLink, /referralAppLinkDestination\(data\)/);
  assert.match(deepLink, /isReferralPath\(data\)/);
  assert.match(deepLink, /intent\.setAction\(null\)/);
  assert.match(deepLink, /connectCloud\(referralUrl == null/);
  assert.match(destination, /"https"\.equalsIgnoreCase\(data\.getScheme\(\)\)/);
  assert.match(destination, /"norva\.tv"\.equalsIgnoreCase\(data\.getHost\(\)\)/);
  assert.match(destination, /segments\.size\(\) != 2/);
  assert.match(main, /\^\[A-Za-z0-9_-\]\{32\}\$/);
  assert.match(destination, /appendQueryParameter\("mobile", "1"\)/);
  assert.doesNotMatch(destination, /getQueryParameter|getFragment/);
  assert.match(warm, /setIntent\(intent\)/);
  assert.match(warm, /handleDeepLink\(intent\)/);
});

test('TV relay App Links preserve one bounded fragment and are never replayed', () => {
  const deepLink = method(main, 'private boolean handleDeepLink(Intent intent)');
  const destination = method(
    main,
    'private static String partnersRelayAppLinkDestination(Uri data)',
  );

  assert.match(deepLink, /partnersRelayAppLinkDestination\(data\)/);
  assert.match(
    deepLink,
    /partnersRelayUrl != null[\s\S]{0,260}intent\.setAction\(null\)[\s\S]{0,220}connectCloud\(partnersRelayUrl\)/,
  );
  assert.match(destination, /"https"\.equalsIgnoreCase\(data\.getScheme\(\)\)/);
  assert.match(destination, /"norva\.tv"\.equalsIgnoreCase\(data\.getHost\(\)\)/);
  assert.match(destination, /!"\/app\.html"\.equals\(data\.getPath\(\)\)/);
  assert.match(destination, /data\.getQuery\(\) != null/);
  assert.match(
    destination,
    /\^relay=v1\\\\\.\[A-Za-z0-9_-\]\{43\}\\\\\.\[0-9a-f\]\{64\}\$/,
  );
  assert.match(destination, /encodedFragment\(Uri\.encode\(fragment, "=\._-"\)\)/);
  assert.doesNotMatch(destination, /SharedPreferences|putString|putExtra/);
});

test('process recreation preserves only the public canonical URL, never an attribution claim', () => {
  const save = method(main, 'protected void onSaveInstanceState(Bundle outState)');
  const restore = method(main, 'private boolean restoreCloudContinuity(Bundle savedInstanceState)');
  const canonical = method(main, 'private static String canonicalReferralUrl(String value)');

  assert.match(save, /STATE_PENDING_REFERRAL_URL/);
  assert.match(save, /canonicalReferralUrl\(webView\.getUrl\(\)\)/);
  assert.match(restore, /canonicalReferralUrl\(/);
  assert.match(restore, /connectCloud\(referralUrl\)/);
  assert.match(canonical, /referralAppLinkDestination\(Uri\.parse\(value\)\)/);
  const executableSave = save.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(executableSave, /cookie|claim|token|authorization|bearer/i);
  assert.doesNotMatch(
    main,
    /\bPREF_[A-Z0-9_]*(?:REFERRAL|CLAIM)|prefs\(\)\.edit\(\)\s*\.putString\(STATE_PENDING_REFERRAL_URL/i,
    'referral and claim material must not enter SharedPreferences',
  );
  assert.match(main, /"partners"\.equals\(page\)/);
});

test('native partner sharing is an origin-scoped main-frame WebMessageListener', () => {
  const install = method(main, 'private void installOriginScopedPartnerShareChannel()');

  assert.match(install, /WebViewFeature\.WEB_MESSAGE_LISTENER/);
  assert.match(install, /addWebMessageListener\(webView, "NorvaShareNative"/);
  assert.match(install, /Collections\.singleton\("https:\/\/norva\.tv"\)/);
  assert.match(install, /!isMainFrame/);
  assert.match(install, /isTrustedCloudUrl\(sourceOrigin\.toString\(\)\)/);
  assert.match(install, /isTrustedPartnersPage\(view\.getUrl\(\)\)/);
  assert.doesNotMatch(
    main,
    /addJavascriptInterface\([^;\n]*NorvaShareNative/,
    'sharing must never use a generic JavascriptInterface',
  );
});

test('share protocol is versioned, bounded, exact-schema and replay protected', () => {
  const dispatch = method(
    main,
    'private void dispatchPartnerShareMessage(String raw, JavaScriptReplyProxy replyProxy)',
  );
  const consume = method(main, 'private boolean consumePartnerShareRequestId(String requestId)');
  const strictText = method(main, 'private static String strictPartnerShareText(');

  assert.match(dispatch, /raw\.length\(\) > MAX_PARTNER_SHARE_MESSAGE_CHARS/);
  assert.match(dispatch, /hasExactKeys\(request, "version", "requestId", "method", "payload"\)/);
  assert.match(dispatch, /PARTNER_SHARE_PROTOCOL_VERSION/);
  assert.match(
    dispatch,
    /hasExactKeys\([\s\S]*payload, "url", "message", "disclosure", "chooserTitle"\)/,
  );
  assert.match(dispatch, /consumePartnerShareRequestId\(requestId\)/);
  assert.match(consume, /handledShareRequestIds\.contains\(requestId\)/);
  assert.match(consume, /MAX_HANDLED_SHARE_REQUEST_IDS/);
  assert.match(strictText, /Character\.isISOControl/);
  assert.match(main, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,79\}\$/);
});

test('ACTION_SEND keeps message, disclosure and canonical URL indivisible', () => {
  const dispatch = method(
    main,
    'private void dispatchPartnerShareMessage(String raw, JavaScriptReplyProxy replyProxy)',
  );
  const canonical = method(
    main,
    'private static String canonicalShareReferralUrl(String value)',
  );

  assert.match(canonical, /canonicalReferralUrl\(value\)/);
  assert.match(canonical, /appendPath\("r"\)/);
  assert.match(canonical, /appendPath\(uri\.getLastPathSegment\(\)\)/);
  assert.doesNotMatch(canonical, /appendQueryParameter/);
  assert.match(
    dispatch,
    /message \+ "\\n\\n" \+ disclosure \+ "\\n" \+ url/,
  );
  assert.match(dispatch, /new Intent\(Intent\.ACTION_SEND\)/);
  assert.match(dispatch, /setType\("text\/plain"\)/);
  assert.match(dispatch, /Intent\.EXTRA_TEXT, shareText/);
  assert.match(dispatch, /Intent\.createChooser\(sendIntent, chooserTitle\)/);
  assert.match(dispatch, /"presented"/);
  assert.doesNotMatch(dispatch, /"shared"/);
});

test('native QR export is explicitly fail-closed without legacy storage permissions', () => {
  const dispatch = method(
    main,
    'private void dispatchPartnerShareMessage(String raw, JavaScriptReplyProxy replyProxy)',
  );

  assert.match(dispatch, /"exportReferralQr"/);
  assert.match(dispatch, /"semantic_qr_validation_unavailable"/);
  assert.match(dispatch, /"unavailable"/);
  assert.doesNotMatch(
    manifest,
    /android\.permission\.(?:READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE)/,
  );
  assert.doesNotMatch(main, /MediaStore|ACTION_CREATE_DOCUMENT|pngBase64/);
});
