const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Hetzner GoTrue uses one mandatory signed HTTPS auth-email hook and no empty SMTP fallback', () => {
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const auth = compose.slice(compose.indexOf('  auth:'), compose.indexOf('  # --- PostgREST'));

  assert.match(auth, /GOTRUE_HOOK_SEND_EMAIL_ENABLED: "true"/);
  assert.match(
    auth,
    /GOTRUE_HOOK_SEND_EMAIL_URI: \$\{AUTH_SEND_EMAIL_HOOK_URI:\?AUTH_SEND_EMAIL_HOOK_URI is required for Auth email\}/,
  );
  assert.match(
    auth,
    /GOTRUE_HOOK_SEND_EMAIL_SECRETS: \$\{SEND_EMAIL_HOOK_SECRET:\?SEND_EMAIL_HOOK_SECRET is required for Auth email\}/,
  );
  assert.match(auth, /GOTRUE_MAILER_EXTERNAL_HOSTS:/);
  assert.match(auth, /GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: "true"/);
  assert.equal((auth.match(/GOTRUE_MAILER_NOTIFICATIONS_[A-Z_]+_ENABLED: "false"/g) || []).length, 7);
  assert.doesNotMatch(auth, /GOTRUE_SMTP_(?:HOST|USER|PASS):/);
});

test('both Edge replicas inherit the same required hook verifier and explicit branded sender', () => {
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const edge = compose.slice(
    compose.indexOf('environment: &functions-env'),
    compose.indexOf('    command:', compose.indexOf('environment: &functions-env')),
  );

  assert.match(
    edge,
    /SEND_EMAIL_HOOK_SECRET: \$\{SEND_EMAIL_HOOK_SECRET:\?SEND_EMAIL_HOOK_SECRET is required for Auth email\}/,
  );
  assert.match(edge, /AUTH_EMAIL_FROM: \$\{AUTH_EMAIL_FROM:-Norva <support@norva\.tv>\}/);
  assert.match(edge, /AUTH_EMAIL_REPLY_TO: \$\{AUTH_EMAIL_REPLY_TO:-support@norva\.tv\}/);
  assert.match(edge, /PUBLIC_SITE_URL: \$\{SITE_URL:\?SITE_URL is required for Auth email links\}/);
  assert.match(compose, /functions2:[\s\S]*environment: \*functions-env/);
});

test('the operator template documents the complete hook pair instead of legacy SMTP fields', () => {
  const example = read('ops/hetzner/.env.hetzner.example');

  assert.match(
    example,
    /^AUTH_SEND_EMAIL_HOOK_URI=https:\/\/api\.norva\.tv\/functions\/v1\/norva-auth-email$/m,
  );
  assert.match(example, /^SEND_EMAIL_HOOK_SECRET=$/m);
  assert.equal((example.match(/^SEND_EMAIL_HOOK_SECRET=/gm) || []).length, 1);
  assert.match(example, /^AUTH_EMAIL_FROM=Norva <support@norva\.tv>$/m);
  assert.match(example, /^AUTH_EMAIL_REPLY_TO=support@norva\.tv$/m);
  assert.match(example, /^GOTRUE_MAILER_EXTERNAL_HOSTS=api\.norva\.tv$/m);
  assert.doesNotMatch(example, /^SMTP_(?:HOST|USER|PASS)=/m);
});

test('the Edge verifier accepts GoTrue pipe-delimited rotation secrets', () => {
  const sender = read('supabase/functions/norva-auth-email/index.ts');

  assert.match(sender, /HOOK_SECRET_RAW\s*\.split\("\|"\)/);
  assert.match(sender, /for \(const secret of HOOK_SECRET_B64S\)/);
  assert.match(sender, /signatures\.some\(\(sig\) => timingSafeEqual\(sig, expected\)\)/);
});

test('every AUTH_EMAIL_FROM Edge fallback uses the reachable canonical support identity', () => {
  for (const relative of [
    'supabase/functions/norva-auth-email/index.ts',
    'supabase/functions/norva-admin/index.ts',
    'supabase/functions/norva-account-delete/index.ts',
    'supabase/functions/norva-revolut-billing/index.ts',
  ]) {
    const sender = read(relative);
    assert.match(sender, /Deno\.env\.get\("AUTH_EMAIL_FROM"\) \?\? "Norva <support@norva\.tv>"/);
    assert.doesNotMatch(sender, /Norva <noreply@norva\.tv>/);
  }
});

test('the auth-email preflight validates configuration, replica parity and a non-sending signature probe', () => {
  const preflight = read('ops/hetzner/scripts/check-auth-email-transport.sh');

  assert.match(preflight, /AUTH_SEND_EMAIL_HOOK_URI must use HTTPS/);
  assert.match(preflight, /AUTH_SEND_EMAIL_HOOK_URI must use SUPABASE_PUBLIC_URL origin/);
  assert.match(preflight, /GOTRUE_HOOK_SEND_EMAIL_ENABLED/);
  assert.match(preflight, /GOTRUE_HOOK_SEND_EMAIL_SECRETS/);
  assert.match(preflight, /IFS='\|' read -r -a hook_secrets/);
  assert.match(preflight, /base64\.b64decode\(payload, validate=True\)/);
  assert.match(preflight, /duplicate_or_missing_env_key/);
  assert.match(preflight, /auth_email_from.*Norva <support@norva\.tv>/s);
  assert.match(preflight, /edge_auth_email_from_drift/);
  assert.match(preflight, /auth_sender_replica_parity=true/);
  assert.match(preflight, /norva-edge-functions-2/);
  assert.match(preflight, /unsigned probe must reach the exact function/i);
  assert.match(preflight, /probe_status" != "401"/);
  assert.match(preflight, /signed_status" != "400"/);
  assert.match(preflight, /signed_probe_verified=true/);
  assert.doesNotMatch(preflight, /echo .*\$(?:hook_secret|resend_key)/);
});

test('Resend key rotation preserves Edge capacity and proves the Auth hook after rotation', () => {
  const rotate = read('ops/hetzner/scripts/rotate-resend-key.sh');
  const first = rotate.indexOf('--no-deps --force-recreate functions >/dev/null');
  const second = rotate.indexOf('--no-deps --force-recreate functions2 >/dev/null');

  assert.ok(first > 0 && second > first, 'Edge replicas must be recreated sequentially');
  assert.match(rotate, /check-auth-email-transport\.sh/);
  assert.match(rotate, /bash "\$AUTH_EMAIL_PREFLIGHT" --config-only/);
  assert.match(rotate, /bash "\$AUTH_EMAIL_PREFLIGHT" --runtime/);
  assert.match(rotate, /auth_hook_verified=true/);
  assert.doesNotMatch(rotate, /GOTRUE_SMTP_PASS|replace_env_key SMTP_PASS/);
});

test('passwordless UI remains account-neutral and does not claim transport acknowledgement', () => {
  const account = read('public/account.html');
  const start = account.indexOf('async function requestMagicLink');
  const end = account.indexOf('function sanitizeReturnTo', start);
  const flow = account.slice(start, end);

  assert.match(flow, /catch \(_\) \{ \/\* neutral \*\/ \}/);
  assert.match(flow, /If that email has a Norva account, we sent a sign-in link/);
  assert.doesNotMatch(flow, /Resend|delivered|provider ID|delivery receipt/i);
});
