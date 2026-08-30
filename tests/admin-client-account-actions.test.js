'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'public/js/pages/AdminPage.js'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase/functions/norva-admin/index.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260830051646_admin_client_account_actions.sql'),
  'utf8',
);
const liveSummaryMigration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260830071456_admin_clients_live_refresh.sql'),
  'utf8',
);

test('admin client controls require an internal reason and exact deletion confirmation', () => {
  const payloadStart = ui.indexOf('    async _accountControlPayload(action, email)');
  const payloadEnd = ui.indexOf('    async _clientAccountAction(btn)', payloadStart);
  const payload = ui.slice(payloadStart, payloadEnd);

  assert.ok(payloadStart >= 0 && payloadEnd > payloadStart);
  assert.match(payload, /value\.length >= 3 && value\.length <= 500/);
  assert.match(payload, /value\.toLowerCase\(\) === expected\.toLowerCase\(\)/);
  assert.match(payload, /Supprimer définitivement/);
  assert.match(payload, /Cette action ne peut pas être annulée/);
  assert.match(ui, /okBtn\.disabled = !valid/);
  assert.match(ui, /aria-live="polite"/);
});

test('ban is audited before Auth mutation and revokes refresh sessions', () => {
  const start = edge.indexOf('    if (action === "suspend")');
  const end = edge.indexOf('    if (action === "delete")', start);
  const section = edge.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(section, /operatorReason\(body\.reason\)/);
  assert.match(section, /beginAccountControlAudit/);
  assert.match(section, /ban_duration: suspend \? "876000h" : "none"/);
  assert.match(section, /admin_revoke_user_sessions/);
  assert.ok(section.indexOf('beginAccountControlAudit') < section.indexOf('updateUserById'));
  assert.match(section, /deletion_in_progress/);
});

test('permanent deletion uses Norva durable workflow and never deletes Auth directly', () => {
  const start = edge.indexOf('    if (action === "delete")');
  const end = edge.indexOf('    return json(req, { error: "Unknown action"', start);
  const section = edge.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(section, /confirmation\.toLowerCase\(\) === targetEmail\.trim\(\)\.toLowerCase\(\)/);
  assert.match(section, /getAuthenticatorAssuranceLevel\(token\)/);
  assert.match(section, /assurance\.currentLevel !== "aal2"/);
  assert.match(section, /code: "aal2_required"/);
  assert.match(section, /partners_service_prepare_account_deletion/);
  assert.match(section, /norva_begin_account_deletion_workflow/);
  assert.match(section, /partners_financial_closure_pending/);
  assert.match(section, /deletionPending: true/);
  assert.doesNotMatch(section, /deleteUser\s*\(/);
  assert.ok(section.indexOf('getAuthenticatorAssuranceLevel') < section.indexOf('beginAccountControlAudit'));
  assert.ok(section.indexOf('partners_service_prepare_account_deletion') < section.indexOf('norva_begin_account_deletion_workflow'));
});

test('self-lockout and last-active-admin protections cover deletion', () => {
  assert.match(edge, /userId === actorId && action === "delete"/);
  assert.match(edge, /action === "delete"[\s\S]{0,220}admin_count_active/);
});

test('session revocation RPC is service-role-only and scoped to one user', () => {
  assert.match(migration, /perform public\.norva_credential_require_service_role\(\)/);
  assert.match(migration, /auth\.refresh_tokens[\s\S]*token\.user_id = p_user_id::text/);
  assert.match(migration, /auth\.sessions[\s\S]*session\.user_id = p_user_id/);
  assert.match(migration, /revoke all on function public\.admin_revoke_user_sessions\(uuid\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_revoke_user_sessions\(uuid\)[\s\S]*to service_role/);
});

test('client counters use a live admin-gated summary instead of the dashboard cache', () => {
  assert.match(liveSummaryMigration, /create or replace function public\.admin_clients_summary\(\)/);
  assert.match(liveSummaryMigration, /if not public\.is_admin\(\)/);
  assert.match(liveSummaryMigration, /security definer[\s\S]*set search_path = ''/);
  assert.match(liveSummaryMigration, /from auth\.users/);
  assert.match(liveSummaryMigration, /revoke all on function public\.admin_clients_summary\(\)[\s\S]*from public, anon, authenticated/);
  assert.match(liveSummaryMigration, /grant execute on function public\.admin_clients_summary\(\)[\s\S]*to authenticated/);
  assert.match(ui, /this\._rpc\('admin_clients_summary'\)/);
  assert.match(ui, /error\?\.payload\?\.code !== 'PGRST202'/);
});

test('Clients refreshes live data while visible and stops polling when hidden', () => {
  const pageStart = ui.indexOf('    _pageClients()');
  const pageEnd = ui.indexOf('    // Compact summary only', pageStart);
  const pageSection = ui.slice(pageStart, pageEnd);
  const hideStart = ui.indexOf('    hide()');
  const hideEnd = ui.indexOf('    // Whitelist CRM routes', hideStart);
  const hideSection = ui.slice(hideStart, hideEnd);

  assert.ok(pageStart >= 0 && pageEnd > pageStart);
  assert.match(pageSection, /window\.clearInterval\(this\._clientPoll\)/);
  assert.match(pageSection, /this\._route !== 'clients'/);
  assert.match(pageSection, /document\.visibilityState !== 'visible'/);
  assert.match(pageSection, /this\._loadUsers\(\)[\s\S]*this\._loadClientSummary\(\)/);
  assert.match(pageSection, /}, 30000\)/);
  assert.ok(hideStart >= 0 && hideEnd > hideStart);
  assert.match(hideSection, /window\.clearInterval\(this\._clientPoll\)/);
});
