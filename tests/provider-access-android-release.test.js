const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');

const build = readFileSync('clients/android-phone/app/build.gradle', 'utf8');
const service = readFileSync(
  'clients/android-phone/app/src/main/java/tv/norva/phone/NorvaMessagingService.java',
  'utf8',
);
const manifest = readFileSync(
  'clients/android-phone/app/src/main/AndroidManifest.xml',
  'utf8',
);

test('Provider Access phone release has a fresh Play version', () => {
  assert.match(build, /versionCode 25\b/);
  assert.match(build, /versionName "1\.3\.12"/);
});

test('Provider Access push is data-only, deduplicated, and fixed-route', () => {
  assert.match(manifest, /android:name="\.NorvaMessagingService"[\s\S]*com\.google\.firebase\.MESSAGING_EVENT/);
  assert.doesNotMatch(manifest, /com\.google\.firebase\.messaging\.MESSAGING_EVENT/);
  assert.match(service, /"provider_access"\.equals\(data\.get\("kind"\)\)/);
  assert.match(service, /KEY_PROVIDER_ACCESS_SEEN/);
  assert.match(service, /PROVIDER_ACCESS_LINK\.equals\(deepLink\)/);
  assert.match(service, /https:\/\/norva\.tv\/app\.html\?mobile=1#settings\/sources/);
});
