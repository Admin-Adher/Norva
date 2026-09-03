'use strict';

const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..', '..');
const adminPageScript = path.join(root, 'public', 'js', 'pages', 'AdminPage.js');
const sourceManagerScript = path.join(root, 'public', 'js', 'components', 'SourceManager.js');
const appScript = path.join(root, 'public', 'js', 'app.js');
const mainStyles = path.join(root, 'public', 'css', 'main.css');
const artifacts = path.join(root, 'output', 'playwright');

const stepFor = (journeyKey, channel, deepLink) => ({
  key: `${journeyKey}_${channel}`,
  ordinal: 1,
  channel,
  delay_minutes: channel === 'in_app' ? 15 : 120,
  title: journeyKey === 'continue_watching' ? 'Continue where you left off' : 'Your next step is ready',
  body: journeyKey === 'import_unresolved'
    ? 'Review the saved service details and retry the catalogue import.'
    : 'Open Norva to finish setting up your catalogue.',
  cta_label: journeyKey === 'continue_watching' ? 'Continue watching' : 'Open Norva',
  deep_link: deepLink,
  ttl_seconds: 86_400,
  enabled: true,
  is_marketing: false,
  requires_new_content: false,
});

const journeyFor = (key, name, entryEvent, exitEvent, deepLink, channel = 'push') => ({
  key,
  version: 2,
  name,
  description: `Bounded ${name.toLowerCase()} recovery journey.`,
  status: 'draft',
  entry_event: entryEvent,
  exit_event: exitEvent,
  rollout_percent: 0,
  countries: ['IN', 'BD'],
  limits: {
    cooldown_days: 7,
    push_day: 1,
    push_week: 3,
    email_week: 2,
    quiet_start: 21,
    quiet_end: 9,
  },
  eligibility: {
    currently_eligible: 0,
    potential_internal_test: 2,
    potential_pilot: 11,
    unknown_country: 1,
  },
  metrics: {
    provider_accepted: 0,
    delivered: 0,
    opened: 0,
    dead_letter: 0,
    treatment_users: 0,
    holdout_users: 0,
  },
  conversion: {
    treatment_users: 0,
    treatment_conversions: 0,
    holdout_users: 0,
    holdout_conversions: 0,
  },
  experiment_plan: {
    variable: 'baseline',
    hypothesis: `The baseline ${name.toLowerCase()} sequence improves ${exitEvent} within 72 hours versus no lifecycle message.`,
    primary_metric: exitEvent,
    window_hours: 72,
    target_relative_lift_pct: key === 'no_source' ? 20 : key === 'catalog_ready_no_first_play' ? 15 : null,
    unsubscribe_lift_guardrail_pp: 0.5,
    provider_rejection_guardrail_pp: 0.5,
    snapshot_status: 'immutable',
  },
  experiment_decision: {
    status: key === 'no_source' || key === 'catalog_ready_no_first_play'
      ? 'target_not_met'
      : 'baseline_ready',
    statistical_significance_assessed: false,
    provider_comparison: {
      status: 'within_guardrail',
      previous_config_version: 1,
      previous_rate_pct: 4.8,
      current_rate_pct: 5,
      delta_pp: 0.2,
    },
  },
  experiment_windows: {
    '24h': {
      status: 'measurable',
      treatment_users: 20,
      treatment_conversions: 8,
      treatment_rate_pct: 40,
      holdout_users: 10,
      holdout_conversions: 3,
      holdout_rate_pct: 30,
      absolute_lift_pp: 10,
      relative_uplift_pct: 33.33,
      treatment_unsubscribed: 0,
      holdout_unsubscribed: 0,
      unsubscribe_lift_pp: 0,
    },
    '72h': {
      status: 'measurable',
      treatment_users: 16,
      treatment_conversions: 9,
      treatment_rate_pct: 56.25,
      holdout_users: 8,
      holdout_conversions: 4,
      holdout_rate_pct: 50,
      absolute_lift_pp: 6.25,
      relative_uplift_pct: 12.5,
      treatment_unsubscribed: 1,
      holdout_unsubscribed: 0,
      unsubscribe_lift_pp: 6.25,
    },
    '7d': {
      status: 'measurable',
      treatment_users: 12,
      treatment_conversions: 8,
      treatment_rate_pct: 66.67,
      holdout_users: 6,
      holdout_conversions: 4,
      holdout_rate_pct: 66.67,
      absolute_lift_pp: 0,
      relative_uplift_pct: 0,
      treatment_unsubscribed: 0,
      holdout_unsubscribed: 0,
      unsubscribe_lift_pp: 0,
    },
  },
  experiment_safety: {
    duplicate_dedupe_keys: 0,
    transport_started: 20,
    provider_rejected: 1,
    provider_rejection_rate_pct: 5,
    sent_after_conversion: 0,
    cancelled_after_conversion: 2,
  },
  reporting: {
    cohort_started_at: '2026-08-20T18:00:00Z',
    day_7_due_at: '2026-08-27T18:00:00Z',
    day_14_due_at: '2026-09-03T18:00:00Z',
    day_7_status: 'ready',
    day_14_status: 'ready',
  },
  steps: [stepFor(key, channel, deepLink)],
});

const lifecycleFixture = {
  window_days: 30,
  import_readiness: {
    status: 'passed',
    release_label: 'norva-1.3.16',
    source_commit: '37d4bc08096f214381e44632f58457e35486915e',
    android_version: '1.3.16',
    evidence_sha256: 'e619f8aab64a6d86bc3bc6ff1c728f5294d80c5d61fc12eff840cb2c9e65ff2e',
    checked_at: '2026-09-03T18:00:00Z',
    expires_at: '2026-09-17T18:00:00Z',
    expired: false,
    pilot_gate_open: true,
    checks: {
      m3u_valid: true,
      xtream_valid: true,
      large_catalog_valid: true,
      error_guidance_valid: true,
      android_webview_valid: true,
    },
  },
  runtime: {
    emergency_stop: true,
    audience_mode: 'internal_test',
    reason: 'Prepared locally; delivery remains disabled.',
    updated_at: '2026-09-03T18:00:00Z',
  },
  reachability: {
    total_accounts: 129,
    registered_tokens: 133,
    registered_accounts: 91,
    permission_granted_tokens: 74,
    targetable_tokens: 68,
    targetable_accounts: 63,
    unknown_permission_tokens: 52,
    denied_permission_tokens: 7,
  },
  primary_72h: {
    cohort: 114,
    import_success: 9,
    import_then_first_play: 4,
    rate_pct: 3.51,
    matured_through: '2026-08-31T18:00:00Z',
  },
  dimensions: [
    {
      country_code: 'IN',
      platform: 'android_phone',
      app_version: '1.3.16',
      cohort: 80,
      import_success: 7,
      import_then_first_play: 3,
      rate_pct: 3.75,
    },
    {
      country_code: 'BD',
      platform: 'web',
      app_version: 'web',
      cohort: 34,
      import_success: 2,
      import_then_first_play: 1,
      rate_pct: 2.94,
    },
  ],
  journeys: [
    journeyFor('no_source', 'No source', 'signup_completed', 'source_attempted', '/app.html#settings/sources', 'in_app'),
    journeyFor('import_unresolved', 'Import unresolved', 'source_import_failed', 'import_success', '/app.html#settings/sources', 'push'),
    journeyFor('catalog_ready_no_first_play', 'Catalogue ready', 'import_success', 'first_play', '/app.html#home', 'email'),
    journeyFor('continue_watching', 'Continue watching', 'playback_abandoned', 'playback_resumed', '/app.html#home/resume', 'push'),
  ],
  dead_letters: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      journey_key: 'import_unresolved',
      step_key: 'import_unresolved_push',
      last_error_family: 'provider_unavailable',
      attempt_count: 5,
      expires_at: '2026-09-04T18:00:00Z',
    },
  ],
  audit_history: [
    {
      action: 'journey_saved',
      journey_key: 'no_source',
      reason: 'Initial bounded configuration.',
      actor_ref: 'operator-4f19',
      created_at: '2026-09-03T18:00:00Z',
    },
  ],
};

async function mountLifecycleCenter(page, fixture = lifecycleFixture) {
  await page.setContent(`<!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <style>html,body,.main-content{width:100%;height:100%;margin:0}body{overflow:hidden}</style>
      </head>
      <body><main class="main-content" id="main-content"></main></body>
    </html>`);
  await page.addStyleTag({ path: mainStyles });
  await page.addScriptTag({ path: adminPageScript });
  await page.evaluate((fixture) => {
    window.__lifecycleAdminCalls = [];
    window.AdminPage.prototype._refreshSupportBadge = async () => {};
    const admin = new window.AdminPage({ navigateTo: () => {} });
    admin._ensureLayout();
    document.getElementById('page-admin').classList.add('active');
    admin._route = 'marketing';
    admin._notificationView = 'journeys';
    admin._notificationCenterAvailable = true;
    admin._notificationOverview = {};
    admin._notificationSchedules = [];
    admin._notificationRules = [];
    admin._notificationSystemRules = [];
    admin._notificationAudienceCounts = null;
    admin._behavioralLifecycle = fixture;
    admin._rpc = async (name, args) => {
      window.__lifecycleAdminCalls.push({ name, args });
      return true;
    };
    admin._loadNotificationCenter = async () => {};
    admin._wireNotificationComposer = () => {};
    admin._renderNotificationSchedules = () => {};
    admin._renderNotificationAutomations = () => {};
    admin._wirePushLogControls = () => {};
    admin._loadPushLog = async () => {};
    document.getElementById('crm-view').innerHTML = '<div id="mkt-notification-center" aria-live="polite"></div>';
    admin._renderNotificationCenter();
    window.__lifecycleAdmin = admin;
  }, fixture);
}

test('a real pilot stays closed until immutable import-readiness evidence is recorded', async ({ page }) => {
  const blockedFixture = JSON.parse(JSON.stringify(lifecycleFixture));
  blockedFixture.import_readiness = {
    status: 'missing',
    expired: true,
    pilot_gate_open: false,
    checks: {
      m3u_valid: false,
      xtream_valid: false,
      large_catalog_valid: false,
      error_guidance_valid: false,
      android_webview_valid: false,
    },
  };
  await mountLifecycleCenter(page, blockedFixture);

  const runtime = page.locator('[data-lifecycle-runtime-root]');
  const pilot = runtime.getByRole('button', { name: 'Préparer le pilote IN / BD' });
  await expect(pilot).toHaveAttribute('aria-disabled', 'true');
  await pilot.click({ force: true });
  await expect(runtime.locator('[data-lifecycle-runtime-confirm]')).toBeHidden();
  await expect(runtime.locator('[data-lifecycle-runtime-status]')).toContainText('Pilote refusé');
  await expect(runtime.locator('[data-lifecycle-runtime-status]')).toHaveAttribute('role', 'alert');
  expect(await page.evaluate(() => window.__lifecycleAdminCalls.length)).toBe(0);

  const readiness = runtime.locator('[data-lifecycle-import-readiness]');
  await readiness.getByRole('button', { name: 'Enregistrer une preuve de staging' }).click();
  const form = readiness.locator('[data-lifecycle-readiness-form]');
  await expect(form).toBeVisible();
  const record = readiness.getByRole('button', { name: 'Enregistrer l’attestation' });
  await expect(record).toBeDisabled();
  await readiness.locator('[data-lifecycle-readiness-field="release"]').fill('norva-1.3.17');
  await readiness.locator('[data-lifecycle-readiness-field="android"]').fill('1.3.17');
  await readiness.locator('[data-lifecycle-readiness-field="commit"]').fill('A'.repeat(40));
  await readiness.locator('[data-lifecycle-readiness-field="evidence"]').fill('B'.repeat(64));
  await expect(readiness.locator('[data-lifecycle-readiness-expected]')).toContainText('RECORD IMPORT FAILURE');
  await readiness.locator('[data-lifecycle-readiness-confirm]').fill('RECORD IMPORT FAILURE');
  await expect(record).toBeEnabled();

  for (const name of ['m3u', 'xtream', 'large-catalogue', 'error-guidance', 'android-webview']) {
    await readiness.locator(`[data-lifecycle-readiness-check="${name}"]`).check();
  }
  await expect(readiness.locator('[data-lifecycle-readiness-confirm]')).toHaveValue('');
  await expect(readiness.locator('[data-lifecycle-readiness-expected]')).toContainText('VERIFY IMPORT READINESS');
  await readiness.locator('[data-lifecycle-readiness-confirm]').fill('VERIFY IMPORT READINESS');
  await expect(record).toBeEnabled();
  await record.click();

  await expect.poll(() => page.evaluate(() => window.__lifecycleAdminCalls.length)).toBe(1);
  expect(await page.evaluate(() => window.__lifecycleAdminCalls[0])).toEqual({
    name: 'admin_record_behavioral_import_readiness',
    args: {
      p_release_label: 'norva-1.3.17',
      p_source_commit: 'a'.repeat(40),
      p_android_version: '1.3.17',
      p_evidence_sha256: 'b'.repeat(64),
      p_m3u_valid: true,
      p_xtream_valid: true,
      p_large_catalog_valid: true,
      p_error_guidance_valid: true,
      p_android_webview_valid: true,
      p_confirmation: 'VERIFY IMPORT READINESS',
    },
  });
  await expect(form).toBeHidden();
});

test('the real Marketing lifecycle surface is responsive, bounded and fail-closed', async ({
  page,
}, testInfo) => {
  await mountLifecycleCenter(page);

  await expect(page.locator('[data-lifecycle-journey]')).toHaveCount(4);
  await expect(page.getByText('Arrêt d’urgence actif', { exact: true })).toBeVisible();
  await expect(page.getByText('129', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('133', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/comptes et 133 jetons mesurent des objets différents/)).toBeVisible();
  await expect(page.locator('.notif-step-preview')).toHaveCount(12);
  await expect(page.getByRole('columnheader', { name: 'Pays' })).toBeVisible();
  await expect(page.getByText('Aucune livraison en lettre morte.')).toHaveCount(0);
  await expect(page.locator('[data-lifecycle-field="push-day"]').first()).toHaveAttribute('max', '1');
  await expect(page.locator('[data-lifecycle-field="push-week"]').first()).toHaveAttribute('max', '3');
  await expect(page.locator('[data-lifecycle-field="email-week"]').first()).toHaveAttribute('max', '2');

  const firstExperiment = page.locator('[data-lifecycle-experiment]').first();
  await expect(firstExperiment).toContainText('Expérience 24 h · 72 h · 7 jours');
  await expect(firstExperiment).toContainText('Baseline / aucun changement expérimental');
  await firstExperiment.locator('summary').click();
  await expect(firstExperiment).toHaveAttribute('open', '');
  await expect(firstExperiment.locator('[data-experiment-window="24h"]')).toContainText('40 %');
  await expect(firstExperiment.locator('[data-experiment-window="72h"]')).toContainText('56,25 %');
  await expect(firstExperiment.locator('[data-experiment-window="7d"]')).toContainText('66,67 %');
  await expect(firstExperiment).toContainText(/0\s*envois après conversion/);
  await expect(firstExperiment).toContainText('Rapport J+7 prêt');
  await expect(firstExperiment).toContainText('Décision directionnelle : Cible non atteinte');
  await expect(firstExperiment).toContainText('+0,2 pt face à la version précédente');
  const scrollHint = firstExperiment.locator('.notif-scroll-hint');
  if (testInfo.project.name.includes('android-mobile')) {
    await expect(scrollHint).toBeVisible();
  } else {
    await expect(scrollHint).toBeHidden();
  }
  await expect(page.getByText(/Cohortes disposant de 72 heures complètes/)).toBeVisible();

  const firstStep = page.locator('[data-lifecycle-journey="no_source"] [data-lifecycle-step]').first();
  await firstStep.locator('summary').click();
  await expect(firstStep.getByText('Confidentialité du message.', { exact: true })).toBeVisible();
  await expect(firstStep.locator('[data-step-field="deep-link"] option')).toHaveCount(1);
  await expect(firstStep.locator('[data-step-field="new-content"]')).toHaveCount(0);
  const stepTitle = firstStep.locator('[data-step-field="title"]');
  const stepSave = firstStep.locator('[data-lifecycle-step-save]');
  await stepTitle.fill('Open provider.example');
  await expect(stepTitle).toHaveAttribute('aria-invalid', 'true');
  await expect(stepSave).toBeDisabled();
  await expect(firstStep.locator('[data-lifecycle-step-status]')).toContainText('Retirez tout domaine externe');
  await expect(firstStep.locator('[data-lifecycle-step-status]')).toHaveAttribute('role', 'alert');
  await stepTitle.fill('Your next step is ready');
  await expect(stepTitle).not.toHaveAttribute('aria-invalid', 'true');
  await expect(stepSave).toBeEnabled();
  await expect(firstStep.locator('[data-lifecycle-step-status]')).toContainText('le serveur le vérifiera encore');

  const continueStep = page.locator('[data-lifecycle-journey="continue_watching"] [data-lifecycle-step]').first();
  await continueStep.locator('summary').click();
  await expect(continueStep.locator('[data-step-field="new-content"]')).toHaveCount(1);
  await expect(continueStep.locator('[data-step-field="deep-link"] option')).toHaveCount(2);

  const renderedText = await page.locator('#notif-panel-journeys').innerText();
  expect(renderedText).not.toMatch(/https?:\/\/|username=|password=|restream\.re/i);

  const geometry = await page.evaluate(() => {
    const panel = document.getElementById('notif-panel-journeys');
    const buttons = [...panel.querySelectorAll('button')].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    return {
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      panelOverflow: Math.max(0, panel.scrollWidth - panel.clientWidth),
      experimentOverflow: Math.max(0, panel.querySelector('[data-lifecycle-experiment]').scrollWidth
        - panel.querySelector('[data-lifecycle-experiment]').clientWidth),
      shortestButton: Math.min(...buttons.map((button) => button.getBoundingClientRect().height)),
    };
  });
  expect(geometry.pageOverflow).toBe(0);
  expect(geometry.panelOverflow).toBe(0);
  expect(geometry.experimentOverflow).toBe(0);
  expect(geometry.shortestButton).toBeGreaterThanOrEqual(43.5);

  await page.screenshot({
    path: path.join(artifacts, `behavioral-lifecycle-initial-${testInfo.project.name}.png`),
    fullPage: false,
  });

  const runtime = page.locator('[data-lifecycle-runtime-root]');
  await runtime.getByRole('button', { name: 'Préparer le pilote IN / BD' }).click();
  const runtimeConfirm = runtime.locator('[data-lifecycle-runtime-confirm]');
  await expect(runtimeConfirm).toBeVisible();
  const runtimeButton = runtime.locator('[data-lifecycle-runtime-confirm-button]');
  await runtime.locator('[data-lifecycle-runtime-typed]').fill('START PILOT');
  await runtime.locator('[data-lifecycle-runtime-reason]').fill('court');
  await expect(runtimeButton).toBeDisabled();
  await runtime.locator('[data-lifecycle-runtime-reason]').fill('Validated browser-only pilot rehearsal.');
  await expect(runtimeButton).toBeEnabled();
  expect(await page.evaluate(() => window.__lifecycleAdminCalls.length)).toBe(0);
  await runtimeButton.click();
  await expect.poll(() => page.evaluate(() => window.__lifecycleAdminCalls.length)).toBe(1);
  expect(await page.evaluate(() => window.__lifecycleAdminCalls[0])).toEqual({
    name: 'admin_update_behavioral_lifecycle_runtime',
    args: {
      p_emergency_stop: false,
      p_audience_mode: 'pilot',
      p_confirmation: 'START PILOT',
      p_reason: 'Validated browser-only pilot rehearsal.',
    },
  });

  const firstJourney = page.locator('[data-lifecycle-journey="no_source"]');
  await expect(firstJourney.locator('[data-lifecycle-field="experiment-variable"]')).toHaveValue('baseline');
  await expect(firstJourney.locator('[data-lifecycle-field="experiment-window"]')).toHaveValue('72');
  await expect(firstJourney.locator('[data-lifecycle-field="experiment-target"]')).toHaveValue('20');
  await firstJourney.locator('[data-lifecycle-field="reason"]').fill('Browser-only activation rehearsal.');
  await firstJourney.locator('[data-lifecycle-prepare]').click();
  await expect(firstJourney.locator('[data-lifecycle-confirm]')).toBeHidden();
  await expect(firstJourney.locator('[data-lifecycle-status-message]')).toContainText('supérieur à 0 %');
  await firstJourney.locator('[data-lifecycle-field="rollout"]').fill('5');
  await firstJourney.locator('[data-lifecycle-prepare]').click();
  await expect(firstJourney.locator('[data-lifecycle-confirm]')).toBeVisible();
  const activation = firstJourney.locator('[data-lifecycle-activate]');
  await firstJourney.locator('[data-lifecycle-confirm-input]').fill('ACTIVATE wrong');
  await expect(activation).toBeDisabled();
  await firstJourney.locator('[data-lifecycle-confirm-input]').fill('ACTIVATE no_source');
  await expect(activation).toBeEnabled();

  await page.screenshot({
    path: path.join(artifacts, `behavioral-lifecycle-typed-gate-${testInfo.project.name}.png`),
    fullPage: false,
  });
});

test('a committed lifecycle copy save is never misreported when the view refresh fails', async ({ page }, testInfo) => {
  await mountLifecycleCenter(page);
  await page.evaluate(() => {
    window.__lifecycleAdmin._loadNotificationCenter = async () => {
      throw new Error('simulated post-commit refresh failure');
    };
  });

  const journey = page.locator('[data-lifecycle-journey="no_source"]');
  await journey.locator('[data-lifecycle-field="reason"]').fill('Verified post-commit refresh failure handling.');
  const step = journey.locator('[data-lifecycle-step]').first();
  await step.locator('summary').click();
  const save = step.locator('[data-lifecycle-step-save]');
  await expect(save).toBeEnabled();
  await save.click();

  await expect.poll(() => page.evaluate(() => window.__lifecycleAdminCalls.length)).toBe(1);
  const call = await page.evaluate(() => window.__lifecycleAdminCalls[0]);
  expect(call.name).toBe('admin_update_behavioral_lifecycle_step');
  expect(call.args.p_reason).toBe('Verified post-commit refresh failure handling.');
  await expect(step.locator('[data-lifecycle-step-status]')).toContainText('Modèle enregistré et historisé');
  await expect(step.locator('[data-lifecycle-step-status]')).toContainText('la vue n’a pas pu être actualisée');
  await expect(step.locator('[data-lifecycle-step-status]')).toHaveClass(/is-warning/);
  await expect(step.locator('[data-lifecycle-step-status]')).toHaveAttribute('role', 'status');
  await expect(save).toBeEnabled();
  await page.screenshot({
    path: path.join(artifacts, `behavioral-lifecycle-post-commit-refresh-${testInfo.project.name}.png`),
    fullPage: false,
  });
});

test('committed runtime, activation and DLQ mutations remain unambiguous after a refresh failure', async ({ page }) => {
  await mountLifecycleCenter(page);
  await page.evaluate(() => {
    window.__lifecycleAdmin._loadNotificationCenter = async () => {
      throw new Error('simulated post-commit refresh failure');
    };
  });

  const runtime = page.locator('[data-lifecycle-runtime-root]');
  await runtime.getByRole('button', { name: 'Préparer le test interne' }).click();
  await runtime.locator('[data-lifecycle-runtime-reason]').fill('Verified internal runtime transition.');
  await runtime.locator('[data-lifecycle-runtime-typed]').fill('START INTERNAL TEST');
  await runtime.locator('[data-lifecycle-runtime-confirm-button]').click();
  await expect(runtime.locator('[data-lifecycle-runtime-confirm]')).toBeHidden();
  await expect(runtime.locator('[data-lifecycle-runtime-status]')).toContainText('Changement appliqué');
  await expect(runtime.locator('[data-lifecycle-runtime-status]')).toHaveClass(/is-warning/);

  const journey = page.locator('[data-lifecycle-journey="no_source"]');
  await journey.locator('[data-lifecycle-field="rollout"]').fill('5');
  await journey.locator('[data-lifecycle-field="reason"]').fill('Verified pilot activation transition.');
  await journey.locator('[data-lifecycle-prepare]').click();
  await journey.locator('[data-lifecycle-confirm-input]').fill('ACTIVATE no_source');
  const activate = journey.locator('[data-lifecycle-activate]');
  await activate.click();
  await expect(journey.locator('[data-lifecycle-status-message]')).toContainText('Pilote activé');
  await expect(journey.locator('[data-lifecycle-status-message]')).toHaveClass(/is-warning/);
  await expect(activate).toBeDisabled();

  const dlq = page.locator('[data-lifecycle-dlq="11111111-1111-4111-8111-111111111111"]');
  await dlq.locator('summary').click();
  await dlq.locator('[data-lifecycle-retry-reason]').fill('Verified bounded dead-letter replay.');
  await dlq.locator('[data-lifecycle-retry-confirm]').fill('RETRY 11111111-1111-4111-8111-111111111111');
  const retry = dlq.locator('[data-lifecycle-retry]');
  await retry.click();
  await expect(dlq.locator('[data-lifecycle-retry-status]')).toContainText('replacée dans la file');
  await expect(dlq.locator('[data-lifecycle-retry-status]')).toHaveClass(/is-warning/);
  await expect(retry).toBeDisabled();

  const calls = await page.evaluate(() => window.__lifecycleAdminCalls);
  expect(calls.map(({ name }) => name)).toEqual([
    'admin_update_behavioral_lifecycle_runtime',
    'admin_update_behavioral_lifecycle_journey',
    'admin_retry_behavioral_lifecycle_delivery',
  ]);
});

test('lifecycle routes reject sensitive context and preserve only bounded recovery context', async ({ page }) => {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: appScript });

  const routes = await page.evaluate(() => ({
    settings: window.parseLifecycleRoute('#settings/sources'),
    resume: window.parseLifecycleRoute('#home/resume'),
    bounded: window.parseLifecycleRoute('#settings/sources/help/timeout/m3u'),
    secret: window.parseLifecycleRoute('#settings/sources/help/password_server_url/xtream'),
    injected: window.lifecycleRouteForPayload({
      deepLink: '/app.html#settings/sources',
      journeyKey: 'import_unresolved',
      failureFamily: 'timeout?username=owner&password=secret',
      sourceType: 'xtream',
    }),
    validPayload: window.lifecycleRouteForPayload({
      deepLink: '/app.html#settings/sources',
      journeyKey: 'import_unresolved',
      failureFamily: 'payload_too_large',
      sourceType: 'm3u',
    }),
    validDeliveryId: window.isLifecycleDeliveryId('22222222-2222-4222-8222-222222222222'),
    dashDeliveryId: window.isLifecycleDeliveryId('------------------------------------'),
  }));

  expect(routes.settings).toEqual({
    baseRoute: '/app.html#settings/sources', homeIntent: '', failureFamily: '', sourceType: '',
  });
  expect(routes.resume).toEqual({
    baseRoute: '/app.html#home/resume', homeIntent: 'resume', failureFamily: '', sourceType: '',
  });
  expect(routes.bounded).toEqual({
    baseRoute: '/app.html#settings/sources', homeIntent: '', failureFamily: 'timeout', sourceType: 'm3u',
  });
  expect(routes.secret).toBeNull();
  expect(routes.injected).toBe('/app.html#settings/sources');
  expect(routes.validPayload).toBe('/app.html#settings/sources/help/payload_too_large/m3u');
  expect(routes.validDeliveryId).toBe(true);
  expect(routes.dashDeliveryId).toBe(false);
});

test('the real source manager renders safe contextual recovery without provider secrets', async ({ page }) => {
  await page.setContent(`<!doctype html>
    <html lang="en">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body>
        <section id="tab-sources" class="settings-tab-content active">
          <div class="settings-source-management">
            <div class="tc-intro"><div><p class="tc-intro-title">Your TV services</p><p class="tc-intro-text">Connect a provider.</p></div></div>
            <button id="add-xtream" class="btn btn-primary" type="button">Add provider login</button>
            <button id="add-m3u" class="btn btn-primary" type="button">Add playlist link</button>
            <button id="add-epg" class="btn btn-primary" type="button">Add TV guide</button>
            <div class="source-item needs-attention" data-id="source-safe">
              <button class="source-primary-action btn btn-primary" type="button">Repair</button>
            </div>
          </div>
        </section>
      </body>
    </html>`);
  await page.addStyleTag({ path: mainStyles });
  await page.addScriptTag({ path: sourceManagerScript });
  const outcome = await page.evaluate(() => {
    const manager = Object.create(window.SourceManager.prototype);
    manager.sources = [{ id: 'source-safe', type: 'm3u', name: 'Private service', sync_status: 'error' }];
    manager.sourceStatuses = [];
    const shown = manager.presentLifecycleImportHelp({ failureFamily: 'payload_too_large', sourceType: 'm3u' });
    return { shown, html: document.getElementById('lifecycle-import-help')?.outerHTML || '' };
  });

  expect(outcome.shown).toBe(true);
  const help = page.locator('#lifecycle-import-help');
  await expect(help).toHaveAttribute('role', 'status');
  await expect(help).toHaveAttribute('aria-live', 'polite');
  await expect(help.getByText('Large catalogues are supported.', { exact: false })).toBeVisible();
  await expect(help.getByRole('button', { name: 'Repair' })).toBeVisible();
  expect(outcome.html).not.toMatch(/https?:\/\/|username|password|credential=/i);

  const rejected = await page.evaluate(() => {
    const manager = Object.create(window.SourceManager.prototype);
    manager.sources = [];
    return manager.presentLifecycleImportHelp({
      failureFamily: 'timeout_password_secret',
      sourceType: 'xtream',
    });
  });
  expect(rejected).toBe(false);
  await expect(help).toHaveCount(0);
});
