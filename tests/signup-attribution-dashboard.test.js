const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260729070048_signup_attribution_dashboard.sql');
const account = read('public/account.html');
const authApi = read('public/js/authApi.js');
const admin = read('public/js/pages/AdminPage.js');
const privacy = read('public/privacy.html');
const edgeSource = read('functions/api/signup-context.js');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('signup attribution is private, bounded and separate from billing country', () => {
  const schema = section(
    migration,
    'create table if not exists public.cloud_signup_attribution',
    'create index if not exists cloud_signup_attribution_signed_up_idx',
  );
  assert.match(schema, /signup_platform in \('web', 'mobile_android', 'unknown'\)/);
  assert.doesNotMatch(schema, /android_tv/);
  assert.match(schema, /signup_surface in \('account', 'subscription', 'tv_pairing', 'unknown'\)/);
  assert.match(schema, /location_source in \('cloudflare_edge', 'none'\)/);
  assert.match(schema, /attribution_integrity in \('client_handoff', 'none'\)/);
  assert.match(schema, /fine_location_expires_at timestamptz/);
  assert.match(schema, /references auth\.users\(id\) on delete cascade/);
  assert.doesNotMatch(schema, /\b(?:ip_address|client_ip|user_agent|referrer|pairing_code)\b/i);
  assert.match(migration, /alter table public\.cloud_signup_attribution enable row level security/);
  assert.match(migration, /revoke all on table public\.cloud_signup_attribution from public, anon, authenticated/);
  assert.match(migration, /billing country remains separate/i);
});

test('auth trigger captures only allow-listed analytics hints and never blocks signup', () => {
  const trigger = section(
    migration,
    'create or replace function public.norva_capture_signup_attribution_from_auth()',
    'revoke all on function public.norva_capture_signup_attribution_from_auth()',
  );
  assert.match(trigger, /new\.raw_user_meta_data/);
  assert.match(trigger, /norva_signup_platform/);
  assert.doesNotMatch(trigger, /norva_signup_(?:country|region|city|location_source)/);
  assert.match(trigger, /case when v_has_context then 'signup_request' else 'pending' end/);
  assert.match(trigger, /attribution_integrity[\s\S]*client_handoff/);
  assert.match(trigger, /exception when others[\s\S]*return new/);
  assert.doesNotMatch(trigger, /raw_app_meta_data\s*->>\s*'role'/);
  assert.match(migration, /'historical_backfill'/);
});

test('fine location cannot persist in Auth user metadata', () => {
  const sanitizer = section(
    migration,
    'create or replace function public.norva_sanitize_signup_metadata()',
    'revoke all on function public.norva_sanitize_signup_metadata()',
  );
  for (const key of [
    'norva_signup_country_code',
    'norva_signup_region_code',
    'norva_signup_region_name',
    'norva_signup_city',
    'norva_signup_location_source',
  ]) {
    assert.match(sanitizer, new RegExp(key));
  }
  assert.match(migration, /create trigger norva_sanitize_signup_metadata_before_insert[\s\S]*before insert on auth\.users/);
  assert.match(migration, /create trigger norva_sanitize_signup_metadata_before_update[\s\S]*before update of raw_user_meta_data on auth\.users/);
});

test('OAuth completion can fill only the current fresh pending account', () => {
  const capture = section(
    migration,
    'create or replace function public.capture_signup_attribution(',
    'revoke all on function public.capture_signup_attribution(',
  );
  assert.match(capture, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(capture, /v_created_at < now\(\) - interval '24 hours'/);
  assert.match(capture, /capture_stage not in \('pending', 'signup_request'\)/);
  assert.match(capture, /reason', 'no_context'/);
  assert.match(capture, /reason', 'partial_pending_location'/);
  assert.match(capture, /on conflict \(user_id\) do nothing[\s\S]*for update/);
  assert.match(capture, /where user_id = v_user_id[\s\S]*and capture_stage in \('pending', 'signup_request'\)/);
  assert.match(migration, /grant execute on function public\.capture_signup_attribution\([\s\S]*\) to authenticated/);
  assert.doesNotMatch(capture, /is_admin\(\)/);
});

test('admin attribution RPCs remain server-gated and page-bounded', () => {
  for (const name of [
    'admin_signup_attribution_batch',
    'admin_signup_attribution_detail',
  ]) {
    const rpc = section(
      migration,
      `create or replace function public.${name}`,
      `revoke all on function public.${name}`,
    );
    assert.match(rpc, /if not public\.is_admin\(\)/, name);
  }
  assert.match(migration, /array_length\(p_user_ids, 1\)[\s\S]*> 10000/);
  assert.match(migration, /revoke all on function public\.admin_signup_attribution_detail\(uuid\) from public, anon, authenticated/);
  assert.doesNotMatch(migration, /admin_signup_attribution_export/);
  assert.doesNotMatch(migration, /security definer\s+set search_path = public/i);
});

test('Cloudflare edge endpoint returns coarse geo only and is never cached', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(edgeSource).toString('base64')}`;
  const edge = await import(moduleUrl);
  const request = new Request('https://norva.tv/api/signup-context');
  Object.defineProperty(request, 'cf', {
    value: {
      country: 'fr',
      regionCode: 'IDF',
      region: 'Île-de-France',
      city: 'Paris',
      timezone: 'Europe/Paris',
      latitude: '48.8566',
      longitude: '2.3522',
      postalCode: '75000',
    },
  });
  const response = edge.onRequest({ request });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
  const body = await response.json();
  assert.deepEqual(body, {
    version: 1,
    available: true,
    source: 'cloudflare_edge',
    countryCode: 'FR',
    regionCode: 'IDF',
    regionName: 'Île-de-France',
    city: 'Paris',
  });
  assert.doesNotMatch(JSON.stringify(body), /latitude|longitude|postal|timezone|ip|user.?agent/i);

  const post = edge.onRequest({ request: new Request(request.url, { method: 'POST' }) });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET');
});

test('all account creation paths carry platform, journey and coarse location', () => {
  assert.match(account, /fetch\('\/api\/signup-context'/);
  assert.match(account, /NorvaTV-AndroidPhone[\s\S]*mobile_android/);
  assert.match(account, /target\.pathname === '\/cloud\.html'[\s\S]*return 'tv_pairing'/);
  assert.match(account, /buildSignupAttribution\('email_password', false\)/);
  assert.match(account, /buildSignupAttribution\('email_magic_link', false\)/);
  assert.match(account, /buildSignupAttribution\('email_otp', false\)/);
  assert.match(account, /async function startSocialAuth\(provider = 'google'\)[\s\S]*buildSignupAttribution\(provider, true\)/);
  assert.match(account, /signupContext: signupMetadata\(attribution\)/);
  assert.match(account, /data: attribution \? signupMetadata\(attribution\) : undefined/);
  assert.match(account, /data:\s*signupMetadata\(attribution\)/);
  const metadata = section(account, 'function signupMetadata(context)', 'function storedSignupAttribution()');
  assert.doesNotMatch(metadata, /country|region|city|location_source/i);
  assert.match(account, /NorvaAuth\.rpc\('capture_signup_attribution'/);
  assert.match(account, /async function refreshSignupLocation\(context\)/);
  assert.match(account, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(account, /partial_pending_location[\s\S]*no_new_context/);
  assert.match(account, /persistSignupAttribution\(pending\)/);
  assert.doesNotMatch(account, /(?:ip_address|client_ip|x-forwarded-for|latitude|longitude|postalCode|clientLocale|clientTimezone)/i);
  assert.match(authApi, /async function signUp\(\{ email, password, displayName, signupContext, redirectTo \}\)/);
  assert.match(authApi, /\.\.\.context,[\s\S]*display_name/);
});

test('authenticated handoff consumes the HttpOnly partner claim before redirect', () => {
  const referralCapture = section(
    account,
    'async function capturePendingPartnerReferral()',
    'async function capturePostAuthAttribution(context)',
  );
  const combinedCapture = section(
    account,
    'async function capturePostAuthAttribution(context)',
    'const authTabs =',
  );
  assert.match(referralCapture, /NorvaCloud\?\.partners\?\.claimReferral/);
  assert.match(referralCapture, /return await claim\(\)/);
  assert.doesNotMatch(
    referralCapture,
    /document\.cookie|localStorage|sessionStorage|claimToken|referralToken/,
  );
  assert.match(
    combinedCapture,
    /Promise\.all\(\[[\s\S]*capturePendingSignupAttribution\(context\)[\s\S]*capturePendingPartnerReferral\(\)/,
  );
  assert.ok(
    (account.match(/await capturePostAuthAttribution\(/g) || []).length >= 7,
    'every successful account handoff should attempt same-origin referral consumption',
  );
  assert.doesNotMatch(account, /NorvaCloud\.partners\.claimReferral\([^)]*(?:token|cookie)/i);
});

test('email verification preserves a bounded pairing or subscription journey', () => {
  const redirect = section(account, 'function authEmailRedirectUrl(flow = \'\')', 'async function loadSignupGeoContext()');
  assert.match(redirect, /new URL\('\/account\.html', location\.origin\)/);
  assert.match(redirect, /searchParams\.set\('returnTo', returnTo\)/);
  assert.match(account, /redirectTo: authEmailRedirectUrl\(\)/);
  assert.match(account, /signInWithOtp\(email, authEmailRedirectUrl\(\)/);
  assert.match(account, /url\.pathname === '\/cloud\.html'[\s\S]*\^\[A-HJ-NP-Z2-9\]\{6\}\$[\s\S]*encodeURIComponent\(pair\)/);
});

test('cancelled Google attempts cannot leak into a later signup attribution', () => {
  assert.match(account, /if \(!idToken\) \{[\s\S]*clearStoredSignupAttribution\(\)/);
  assert.match(account, /if \(oauthError\) \{[\s\S]*clearStoredSignupAttribution\(\)/);
  assert.match(account, /if \(socialAuthStarting\) return/);
  assert.match(account, /button\.disabled = socialAuthStarting/);
  assert.match(account, /auth-help-google[\s\S]*startSocialAuth\('google'\)/);
});

test('Admin CRM clearly distinguishes payment country from signup acquisition', () => {
  assert.match(admin, /Pays paiement/);
  assert.match(admin, /admin_signup_attribution_batch/);
  assert.match(admin, /admin_signup_attribution_detail/);
  assert.doesNotMatch(admin, /admin_signup_attribution_export/);
  assert.match(admin, /p_user_ids: list\.map\(row => row\.user_id\)/);
  assert.match(admin, /App d’inscription/);
  assert.match(admin, /Localisation réseau/);
  assert.match(admin, /Aucune adresse IP brute n’est conservée/);
  assert.match(admin, /Pairing TV/);
  assert.match(admin, /écran compagnon/);
  assert.match(admin, /pays_paiement[\s\S]*pays_inscription/);
  assert.doesNotMatch(admin, /ville_inscription/);
  assert.match(admin, /signal analytique indicatif/);
  assert.match(migration, /fine_location_expired/);
});

test('privacy notice documents first-party signup context and no raw IP retention', () => {
  assert.match(privacy, /Last updated: 28 August 2026/);
  assert.match(privacy, /Sign-up context/);
  assert.match(privacy, /approximate country\/region\/city supplied by Cloudflare/);
  assert.match(privacy, /does not retain the raw IP address in this record/);
  assert.match(privacy, /kept separate from billing country and your chosen[\s\S]*catalogue region/);
  assert.match(privacy, /city and region stop being available to administrators at 90 days/i);
});

test('fine location has enforceable retention and the trigger closes the rollout race', () => {
  const triggerPosition = migration.indexOf('create trigger norva_capture_signup_attribution_after_insert');
  const backfillPosition = migration.indexOf("select u.id, u.created_at, 'historical_backfill'");
  assert.ok(triggerPosition > 0 && triggerPosition < backfillPosition);
  assert.match(migration, /create or replace function public\.norva_prune_signup_fine_location\(\)/);
  assert.match(migration, /set region_code = null,[\s\S]*region_name = null,[\s\S]*city = null/);
  assert.match(migration, /norva-signup-fine-location-prune/);
  assert.match(migration, /'\*\/15 \* \* \* \*'/);
  assert.match(migration, /case when a\.fine_location_expires_at <= now\(\) then null else a\.city end/);
});
