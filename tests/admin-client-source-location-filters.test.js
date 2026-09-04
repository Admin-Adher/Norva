'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260904151000_admin_client_source_location_filters.sql'),
  'utf8',
).replace(/\r\n/g, '\n');
const admin = fs.readFileSync(
  path.join(root, 'public/js/pages/AdminPage.js'),
  'utf8',
).replace(/\r\n/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('paginated Admin Clients filters sources and signup country before limit/offset', () => {
  const page = section(
    migration,
    'create or replace function public.admin_users_page(',
    'drop function if exists public.admin_users_export',
  );
  assert.match(page, /p_source_bucket text default null/);
  assert.match(page, /p_signup_country text default null/);
  assert.match(page, /left join public\.cloud_signup_attribution sa on sa\.user_id = u\.id/g);
  assert.match(page, /left join lateral \([\s\S]*public\.cloud_sources[\s\S]*\) src on true/g);
  assert.ok((page.match(/v_signup_cc = '\?\?' and sa\.country_code is null/g) || []).length >= 2);
  assert.ok((page.match(/v_source_bucket = '2_3' and src\.n between 2 and 3/g) || []).length >= 2);
  assert.ok((page.match(/v_source_bucket = '4_plus' and src\.n >= 4/g) || []).length >= 2);
  assert.match(page, /'signup_countries', v_signup_countries/);
  assert.match(page, /'signup_country_missing', v_signup_country_missing/);
  assert.match(page, /'source_buckets', v_source_buckets/);
  assert.match(page, /if not public\.is_admin\(\)/);
  assert.match(page, /limit v_lim offset v_off/);
});

test('CSV export applies exactly the same source and signup-country dimensions', () => {
  const exported = section(
    migration,
    'create or replace function public.admin_users_export(',
    'comment on function public.admin_users_page(',
  );
  assert.match(exported, /p_source_bucket text default null/);
  assert.match(exported, /p_signup_country text default null/);
  assert.match(exported, /v_signup_cc = '\?\?' and sa\.country_code is null/);
  assert.match(exported, /v_source_bucket = '0' and src\.n = 0/);
  assert.match(exported, /v_source_bucket = '1' and src\.n = 1/);
  assert.match(exported, /v_source_bucket = '2_3' and src\.n between 2 and 3/);
  assert.match(exported, /v_source_bucket = '4_plus' and src\.n >= 4/);
  assert.match(exported, /if not public\.is_admin\(\)/);
  assert.match(exported, /limit v_lim/);
});

test('Admin client UI keeps signup location separate and sends filters server-side', () => {
  assert.match(admin, /id="admin-users-sources"/);
  assert.match(admin, /id="admin-users-signup-country"/);
  assert.match(admin, /Pays utilisateur à l’inscription/);
  assert.match(admin, /Localisation à l’inscription/);
  assert.match(admin, /Pays de paiement/);
  assert.match(admin, /p_source_bucket: s\.sourceBucket \|\| null/);
  assert.match(admin, /p_signup_country: s\.signupCountry \|\| null/);
  assert.match(admin, /p_source_bucket: this\._users\.sourceBucket \|\| null/);
  assert.match(admin, /p_signup_country: this\._users\.signupCountry \|\| null/);
  assert.doesNotMatch(admin, /position actuelle de la personne/);
});
