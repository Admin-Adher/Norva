const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

const trialMigration = read('supabase/migrations/20260721232000_trial_reminder_provider_safety.sql');
const deliveryMigration = read('supabase/migrations/20260722003000_lifecycle_email_delivery_outbox.sql');
const retireRecipientMigration = read('supabase/migrations/20260721232100_retire_admin_alert_recipient_discovery.sql');
const lifecycle = read('supabase/functions/norva-lifecycle/index.ts');
const admin = read('supabase/functions/norva-admin/index.ts');
const compose = read('ops/hetzner/docker-compose.supabase.yml');
const envExample = read('ops/hetzner/.env.hetzner.example');

test('trial reminders are deduplicated per user, trial instance and J-3/J-1 offset', () => {
  assert.match(trialMigration, /create table if not exists public\.cloud_trial_reminder_deliveries/i);
  assert.match(trialMigration, /primary key \(user_id, trial_ends_at, days_before\)/i);
  assert.match(trialMigration, /days_before in \(1, 3\)/i);
  assert.match(trialMigration, /on conflict \(user_id, trial_ends_at, days_before\) do nothing/i);
  assert.match(trialMigration, /for update of e skip locked/i);
  assert.match(trialMigration, /if p_days_before not in \(1, 3\) then/i);
});

test('trial cohorts and copy are provider-correct and internal accounts are fail-closed', () => {
  const sender = trialMigration.slice(
    trialMigration.indexOf('create or replace function public.norva_send_trial_ending_reminders'),
    trialMigration.indexOf('revoke all on function public.norva_send_trial_ending_reminders'),
  );
  assert.match(sender, /e\.provider in \('revolut', 'manual', 'system'\)/i);
  assert.doesNotMatch(sender, /revenuecat|google_play|apple_app_store/i);
  assert.ok((sender.match(/admin_internal_accounts/g) || []).length >= 2);
  assert.match(sender, /r\.provider = 'revolut'/i);
  assert.match(sender, /will renew automatically when the trial ends/i);
  assert.match(sender, /cancel before renewal and you will not be charged/i);
  assert.match(sender, /will not renew automatically and no automatic charge will be made/i);
  assert.match(sender, /https:\/\/norva\.tv\/subscription\.html/i);
  assert.match(sender, /https:\/\/norva\.tv\/subscribe\.html/i);
});

test('DB trial reminder finalizes J-3/J-1 delivery and shared marker only after worker ack', () => {
  const sender = deliveryMigration.slice(
    deliveryMigration.indexOf('create or replace function public.norva_send_trial_ending_reminders'),
    deliveryMigration.indexOf("notify pgrst, 'reload schema'"),
  );
  const complete = deliveryMigration.slice(
    deliveryMigration.indexOf('create or replace function public.complete_branded_email_delivery'),
    deliveryMigration.indexOf('create or replace function public.fail_branded_email_delivery'),
  );
  assert.match(sender, /email_delivery_id=v_delivery/);
  assert.doesNotMatch(sender, /set trial_reminder_email_at|set delivered_at/);
  assert.match(complete, /set delivered_at=coalesce/);
  assert.match(complete, /set trial_reminder_email_at=coalesce/);
  assert.match(trialMigration, /at time zone 'UTC'/i);
  assert.match(trialMigration, /cron\.schedule\(\s*'norva-trial-ending-3d'/i);
  assert.match(trialMigration, /cron\.schedule\(\s*'norva-trial-ending-1d'/i);
  assert.doesNotMatch(lifecycle, /runTrialReminder|LC_TRIAL/);
  assert.match(lifecycle, /enabled: \{ trial: false,/);
  assert.match(lifecycle, /trial_reminder: "db_cron_canonical"/);
});

test('ops email is explicit, singular, validated and never discovered from Auth/Admin', () => {
  assert.match(admin, /Deno\.env\.get\("NORVA_OPS_EMAIL"\)/);
  assert.match(admin, /\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\.\[\^\\s@\]\+\$/);
  assert.match(admin, /const recipients = OPS_EMAIL \? \[OPS_EMAIL\] : \[\]/);
  assert.doesNotMatch(admin, /admin_alert_recipients/);
  assert.match(retireRecipientMigration, /drop function if exists public\.admin_alert_recipients\(\)/i);
  assert.match(compose, /NORVA_OPS_EMAIL:\s*\$\{NORVA_OPS_EMAIL:-\}/);
  assert.match(envExample, /NORVA_OPS_EMAIL=/);
});

test('ops notifications stay aggregated with Telegram fallback and six-hour cooldown', () => {
  assert.match(admin, /const ALERT_COOLDOWN_MS = 6 \* 3600 \* 1000/);
  assert.match(admin, /toAlert\.map\(\(p\) => `• \$\{tgEscape\(p\.detail\)\}`\)\.join\("\\n"\)/);
  assert.match(admin, /const tgOk = await sendTelegram/);
  assert.match(admin, /if \(resendKey && recipients\.length\)/);
  assert.match(admin, /email_configured: Boolean\(OPS_EMAIL\)/);
  assert.doesNotMatch(admin, /for \(const p of toAlert\)[\s\S]{0,500}api\.resend\.com\/emails/);
});

test('ops recovery state is acknowledged only after a confirmed notification channel', () => {
  const healedAt = admin.indexOf('if (healed.length)');
  const recoverySendAt = admin.indexOf('const recoveryTelegramOk = await sendTelegram', healedAt);
  const clearAt = admin.indexOf('admin.from("admin_alert_state").delete().in("key", healed)', healedAt);
  assert.ok(healedAt >= 0 && recoverySendAt > healedAt && clearAt > recoverySendAt);
  assert.match(admin, /if \(recoveryTelegramOk\) \{[\s\S]*recoveryDelivered = true/);
  assert.match(admin, /recoveryResponse\.ok && typeof recoveryPayload\.id === "string" && recoveryPayload\.id/);
  assert.match(admin, /if \(recoveryDelivered\) \{[\s\S]*admin\.from\("admin_alert_state"\)\.delete\(\)\.in\("key", healed\)/);
  assert.match(admin, /recovery_pending: healed\.length > 0 && !recoveryStateCleared/);
});

test('ops emails use a bounded and observable Resend transport', () => {
  assert.match(admin, /const htmlEscape = \(/);
  assert.match(admin, /htmlEscape\(p\.detail\)/);
  assert.match(admin, /htmlEscape\(stateDetails\.get\(k\) \?\? k\)/);
  assert.match(admin, /"User-Agent": "Norva-Ops-Email\/2\.0"/);
  assert.match(admin, /"Idempotency-Key": `norva-ops-alert-/);
  assert.match(admin, /"Idempotency-Key": `norva-ops-recovery-/);
  assert.match(admin, /reply_to: OPS_EMAIL/);
  assert.match(admin, /\{ name: "category", value: "operational" \}/);
  assert.match(admin, /\{ name: "flow", value: "ops_health_alert" \}/);
  assert.match(admin, /\{ name: "flow", value: "ops_health_recovery" \}/);
  assert.ok((admin.match(/signal: AbortSignal\.timeout\(8_000\)/g) || []).length >= 2);
  assert.match(admin, /res\.ok && typeof payload\.id === "string" && payload\.id/);
});
