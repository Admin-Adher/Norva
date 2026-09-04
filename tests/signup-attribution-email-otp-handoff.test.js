const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const account = read('public/account.html');
const migration = read('supabase/migrations/20260904152000_signup_attribution_email_otp_handoff.sql');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('verified email-code flow retains coarse attribution only after challenge creation', () => {
  const request = section(
    account,
    "const challenge = await NorvaAuth.requestEmailChallenge({",
    '} catch (error) {',
  );
  assert.match(request, /pendingOtpChallengeId = challenge\.challengeId;[\s\S]*persistSignupAttribution\(attribution\);/);
  assert.match(account, /await capturePostAuthAttribution\(\);/);
  const stored = section(account, 'function persistSignupAttribution(context)', 'async function refreshSignupLocation(context)');
  assert.doesNotMatch(stored, /localStorage|cookie/i);
});

test('database accepts and preserves the email_otp signup method', () => {
  assert.match(migration, /signup_method in \('email_password', 'email_magic_link', 'email_otp', 'google', 'unknown'\)/);
  assert.match(migration, /when 'email_otp' then 'email_otp'/);
  assert.match(migration, /when p_signup_method = 'email_otp' then 'email_otp'/);
  assert.match(migration, /v_created_at < now\(\) - interval '24 hours'/);
  assert.match(migration, /v_user_id uuid := auth\.uid\(\)/);
});

test('historical repair changes method only and never invents location', () => {
  const repair = section(
    migration,
    '-- Correct the method label only',
    "notify pgrst, 'reload schema';",
  );
  assert.match(repair, /set signup_method = 'email_otp'/);
  assert.match(repair, /raw_user_meta_data ->> 'norva_signup_method' = 'email_otp'/);
  assert.doesNotMatch(repair, /country_code\s*=|region_code\s*=|region_name\s*=|city\s*=/);
});
