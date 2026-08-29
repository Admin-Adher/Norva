'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const adminSource = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');
const edgeSource = fs.readFileSync(path.join(root, 'supabase/functions/norva-admin/index.ts'), 'utf8');
const migrationName = fs.readdirSync(path.join(root, 'supabase/migrations'))
  .find((name) => name.endsWith('_marketing_notification_center_v1.sql'));
assert.ok(migrationName, 'notification center migration must exist');
const migrationSource = fs.readFileSync(path.join(root, 'supabase/migrations', migrationName), 'utf8');

const centerStart = adminSource.indexOf('    async _loadNotificationCenter()');
const centerEnd = adminSource.indexOf('    // Espace Promotions', centerStart);
const centerSource = adminSource.slice(centerStart, centerEnd);
const cssStart = adminSource.indexOf('#page-admin .notif-center');
const cssEnd = adminSource.indexOf('#page-admin .mkt-log-clip', cssStart);
const centerCss = adminSource.slice(cssStart, cssEnd);

test('notification center exposes the approved operational sections and inline review', () => {
  assert.ok(centerStart > 0 && centerEnd > centerStart);
  for (const label of ['Composer', 'Programmées', 'Automatiques', 'Historique']) {
    assert.match(centerSource, new RegExp(label));
  }
  assert.match(centerSource, /id="notif-send-review" hidden tabindex="-1"/);
  assert.match(centerSource, /Vérification avant livraison/);
  assert.match(centerSource, /Programmer la campagne/);
  assert.doesNotMatch(centerSource, /window\.confirm/);
  assert.doesNotMatch(centerSource, /[📲📤📱🗂🔎⚙️🚀]/u);
});

test('schedules are editable, duplicable and cancellable before delivery', () => {
  assert.match(centerSource, /admin_save_marketing_notification_schedule/);
  assert.match(centerSource, /admin_cancel_marketing_notification_schedule/);
  assert.match(centerSource, /data-schedule-action="edit"/);
  assert.match(centerSource, /data-schedule-action="duplicate"/);
  assert.match(centerSource, /data-schedule-action="cancel"/);
  assert.match(centerSource, /au moins une minute dans le futur/);
});

test('custom automations only expose the safe existing application events', () => {
  for (const event of ['new_content', 'subtitle_ready', 'subtitle_empty', 'subtitle_failed']) {
    assert.match(adminSource, new RegExp(`'${event}'`));
    assert.match(migrationSource, new RegExp(`'${event}'`));
  }
  assert.match(centerSource, /Règle protégée/);
  assert.match(centerSource, /Créer un push complémentaire/);
  assert.match(centerSource, /admin_save_marketing_notification_rule/);
  assert.match(centerSource, /admin_archive_marketing_notification_rule/);
  assert.match(migrationSource, /trg_enqueue_marketing_notification_automations/);
});

test('worker is cron-authenticated and claims at-most-once jobs', () => {
  assert.match(edgeSource, /notification-center-drain/);
  assert.match(edgeSource, /NORVA_CRON_SHARED_SECRET/);
  assert.match(edgeSource, /NORVA_BACKFILL_TOKEN/);
  assert.match(edgeSource, /claim_due_marketing_notification_schedules/);
  assert.match(edgeSource, /claim_due_marketing_notification_automations/);
  assert.match(migrationSource, /for update skip locked/i);
  assert.match(migrationSource, /status = 'processing'/);
  assert.match(migrationSource, /not retried automatically/);
  const claimStart = migrationSource.indexOf('create or replace function public.claim_due_marketing_notification_schedules');
  const claimEnd = migrationSource.indexOf('create or replace function public.complete_marketing_notification_schedule', claimStart);
  assert.doesNotMatch(migrationSource.slice(claimStart, claimEnd), /set\s+status\s*=\s*'scheduled'/i);
});

test('database surface is RLS protected and browser writes use admin RPCs', () => {
  for (const table of [
    'marketing_notification_schedules',
    'marketing_notification_automation_rules',
    'marketing_notification_automation_queue',
  ]) {
    assert.match(migrationSource, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migrationSource, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`));
  }
  assert.match(migrationSource, /grant execute on function public\.admin_save_marketing_notification_schedule[\s\S]+to authenticated, service_role/);
  assert.match(migrationSource, /grant execute on function public\.claim_due_marketing_notification_schedules[\s\S]+to service_role/);
});

test('notification styles preserve touch size, focus, responsive layout and reduced motion', () => {
  assert.ok(cssStart > 0 && cssEnd > cssStart);
  assert.match(centerCss, /min-height:44px/);
  assert.match(centerCss, /touch-action:manipulation/);
  assert.match(centerCss, /:focus-visible/);
  assert.match(centerCss, /outline:2px solid var\(--color-accent\)/);
  assert.match(adminSource, /@media\(max-width:640px\)[\s\S]+\.notif-schedule-row/);
  assert.match(adminSource, /@media\(max-width:460px\)[\s\S]+\.notif-kpis/);
  assert.match(adminSource, /@media\(prefers-reduced-motion:reduce\)[\s\S]+\.notif-button/);
  assert.doesNotMatch(centerCss, /#[0-9a-fA-F]{3,8}\b/);
});
