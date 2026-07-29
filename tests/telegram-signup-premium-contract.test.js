const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const worker = read('supabase/functions/norva-signup-notify/index.ts');
const telegram = read('supabase/functions/_shared/telegram.ts');
const premiumMigration = read(
  'supabase/migrations/20260729093922_premium_signup_telegram_attribution.sql',
);
const originalMigration = read(
  'supabase/migrations/20260727135652_telegram_signup_notifications.sql',
);

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function executableSignupMessage() {
  const helpers = section(worker, 'function clipped', 'function retryableTelegramStatus');
  const compiled = esbuild.transformSync(
    `${helpers}\nglobalThis.__signupMessage = signupMessage;`,
    { loader: 'ts', format: 'cjs', target: 'es2022' },
  ).code;
  const sandbox = {
    Date,
    Intl,
    encodeURIComponent,
    maskedEmail(value) {
      const clean = String(value ?? '').trim();
      const at = clean.lastIndexOf('@');
      if (at <= 0 || at === clean.length - 1) return 'Adresse e-mail masquée';
      const local = clean.slice(0, at);
      const domain = clean.slice(at + 1);
      return `${local.slice(0, Math.min(2, local.length))}••••@${domain}`;
    },
    tgEscape(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    },
  };
  vm.runInNewContext(compiled, sandbox);
  return sandbox.__signupMessage;
}

test('signup claim consumes only the privacy-bounded attribution projection', () => {
  const claim = section(worker, 'interface SignupClaim', 'interface SignupNotification');
  for (const field of [
    'signup_platform',
    'signup_surface',
    'signup_method',
    'country_code',
    'region_name',
    'capture_stage',
  ]) {
    assert.match(claim, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(claim, /\b(?:city|ip_address|region_code|latitude|longitude|postal_code)\b/i);
});

test('the rendered premium notification matches the approved complete journey', () => {
  const render = executableSignupMessage();
  const notification = render({
    id: 1,
    user_id: '385d8450-1111-4111-8111-111111111111',
    lease_token: '385d8450-2222-4222-8222-222222222222',
    user_email: 'hernandez.jeremy@outlook.fr',
    display_name: 'Jérémy <Hernandez>',
    auth_provider: 'google',
    email_confirmed: true,
    signed_up_at: '2026-07-29T12:32:00.000Z',
    attempt_count: 1,
    signup_platform: 'mobile_android',
    signup_surface: 'tv_pairing',
    signup_method: 'google',
    country_code: 'FR',
    region_name: 'Île-de-France',
    capture_stage: 'auth_return',
  });

  assert.match(notification.text, /✨ <b>Nouvelle inscription Norva<\/b>/);
  assert.match(notification.text, /<b>Jérémy &lt;Hernandez&gt;<\/b>/);
  assert.match(notification.text, /he••••@outlook\.fr/);
  assert.match(notification.text, /📱 Application Android/);
  assert.match(notification.text, /🧭 Pairing TV/);
  assert.match(notification.text, /🔐 Google · Compte vérifié/);
  assert.match(notification.text, /🌍 Île-de-France · France/);
  assert.match(notification.text, /Localisation réseau approximative/);
  assert.match(notification.text, /🕒 29 juil\. 2026 · 14:32/);
  assert.doesNotMatch(notification.text, /Attribution partielle/);
  assert.doesNotMatch(notification.text, /hernandez\.jeremy@|385d8450|Paris\)/);
  assert.equal(
    notification.clientUrl,
    'https://norva.tv/app#admin/client:385d8450-1111-4111-8111-111111111111',
  );
});

test('the rendered timeout fallback stays useful without inventing attribution', () => {
  const render = executableSignupMessage();
  const notification = render({
    id: 2,
    user_id: 'not-a-uuid',
    lease_token: '385d8450-2222-4222-8222-222222222222',
    user_email: null,
    display_name: null,
    auth_provider: 'email',
    email_confirmed: false,
    signed_up_at: '2026-07-29T12:32:00.000Z',
    attempt_count: 1,
    signup_platform: null,
    signup_surface: null,
    signup_method: null,
    country_code: null,
    region_name: null,
    capture_stage: 'partial',
  });

  assert.match(notification.text, /Appareil non déterminé/);
  assert.match(notification.text, /Parcours non déterminé/);
  assert.match(notification.text, /Confirmation en attente/);
  assert.match(notification.text, /🌍 Localisation non disponible/);
  assert.match(notification.text, /⚠️ <b>Attribution partielle<\/b>/);
  assert.equal(notification.clientUrl, 'https://norva.tv/app#admin');
});

test('premium message is human, localized and explicit about approximate attribution', () => {
  const message = section(worker, 'function signupMessage', 'function retryableTelegramStatus');
  assert.match(message, /✨ <b>Nouvelle inscription Norva<\/b>/);
  assert.match(worker, /Application Android/);
  assert.match(worker, /Navigateur Web/);
  assert.match(worker, /Pairing TV/);
  assert.match(message, /Compte vérifié/);
  assert.match(message, /Attribution partielle/);
  assert.match(message, /Localisation réseau approximative/);
  assert.match(message, /Localisation non disponible/);
  assert.match(worker, /timeZone: "Europe\/Paris"/);
  assert.match(message, /<tg-spoiler>/);
  assert.match(message, /\.\.\.\(name \? \[/);
  assert.doesNotMatch(message, /claim\.(?:city|ip_address|region_code)\b/i);
});

test('email is irreversibly masked before Telegram escaping', () => {
  const helper = section(telegram, 'export function maskedEmail', 'export interface TelegramSendResult')
    .replace('export function', 'function')
    .replace('(value: string): string', '(value)');
  const maskedEmail = vm.runInNewContext(`(() => { ${helper}; return maskedEmail; })()`);
  const message = section(worker, 'function signupMessage', 'function retryableTelegramStatus');
  const masked = maskedEmail('hernandez.jeremy@outlook.fr');
  assert.equal(masked, 'he••••@outlook.fr');
  assert.doesNotMatch(masked, /hernandez\.jeremy/);
  assert.match(message, /tgEscape\(maskedEmail\(email\)\)/);
  assert.doesNotMatch(message, /tgEscape\(email\)/);
});

test('UUID is absent from the body and used only by the inline admin action', () => {
  const message = section(worker, 'function signupMessage', 'function retryableTelegramStatus');
  assert.match(message, /\.test\(rawUserId\)/);
  assert.match(
    message,
    /https:\/\/norva\.tv\/app#admin\/client:\$\{encodeURIComponent\(rawUserId\)\}/,
  );

  const body = section(message, 'text: [', '].join("\\n")');
  assert.doesNotMatch(body, /user_id|rawUserId|clientUrl|<code>/);
});

test('signup delivery is protected, has one admin button and disables link previews', () => {
  const call = section(worker, 'sendTelegramDetailed(notification.text', 'if (sent.accepted');
  assert.match(call, /protectContent: true/);
  assert.match(call, /inlineKeyboard: \[\[\{/);
  assert.match(call, /text: "Ouvrir la fiche client"/);
  assert.match(call, /url: notification\.clientUrl/);

  assert.match(telegram, /link_preview_options: \{ is_disabled: true \}/);
  assert.match(telegram, /protect_content: true/);
  assert.match(telegram, /reply_markup: replyMarkup/);
});

test('shared Telegram calls remain source-compatible without options', () => {
  assert.match(
    telegram,
    /export async function sendTelegramDetailed\(\s*text: string,\s*options: TelegramSendOptions = \{\}/,
  );
  assert.match(telegram, /export async function sendTelegram\(text: string\): Promise<boolean>/);
  assert.match(telegram, /sendTelegramDetailed\(text\)/);
});

test('database scheduling gives enrichment 60-120 seconds and wakes complete attribution', () => {
  const schedule = section(
    premiumMigration,
    'create or replace function public.norva_schedule_signup_telegram_enrichment()',
    'revoke all on function public.norva_schedule_signup_telegram_enrichment()',
  );
  assert.match(schedule, /interval '60 seconds'/);
  assert.match(schedule, /date_trunc\('minute', v_signed_up_at \+ interval '120 seconds'\)/);
  assert.match(premiumMigration, /before insert on public\.cloud_signup_telegram_outbox/);

  const wake = section(
    premiumMigration,
    'create or replace function public.norva_wake_signup_telegram_on_attribution()',
    'revoke all on function public.norva_wake_signup_telegram_on_attribution()',
  );
  assert.match(wake, /new\.capture_stage <> 'auth_return'/);
  assert.match(wake, /o\.last_attempt_at is null/);
  assert.match(wake, /set next_attempt_at = v_now/);
  assert.match(wake, /perform net\.http_post/);
  assert.doesNotMatch(wake, /insert into public\.cloud_signup_telegram_outbox/);
});

test('claim joins a minimized attribution projection and refreshes confirmation atomically', () => {
  const claim = section(
    premiumMigration,
    'create function public.claim_signup_telegram_deliveries(',
    'revoke all on function public.claim_signup_telegram_deliveries(',
  );
  for (const field of [
    'signup_platform',
    'signup_surface',
    'signup_method',
    'country_code',
    'region_name',
    'capture_stage',
  ]) {
    assert.match(claim, new RegExp(`\\b${field}\\b`));
  }
  assert.match(claim, /left join public\.cloud_signup_attribution a/);
  assert.match(claim, /email_confirmed = u\.email_confirmed_at is not null/);
  assert.match(claim, /for update of o skip locked/);
  assert.doesNotMatch(
    section(
      originalMigration,
      'create table if not exists public.cloud_signup_telegram_outbox',
      'create index if not exists cloud_signup_telegram_due_idx',
    ),
    /\b(?:country_code|region_name|region_code|city|ip_address)\b/i,
  );
});

test('premium claim remains service-only and the outbox keeps one logical event per user', () => {
  assert.match(
    premiumMigration,
    /alter table public\.cloud_signup_telegram_outbox enable row level security/,
  );
  assert.match(
    premiumMigration,
    /revoke all on function public\.claim_signup_telegram_deliveries\([\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    premiumMigration,
    /grant execute on function public\.claim_signup_telegram_deliveries\([\s\S]*to service_role/,
  );
  assert.match(
    originalMigration,
    /constraint cloud_signup_telegram_user_unique unique \(user_id\)/,
  );
});
