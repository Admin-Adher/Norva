'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function latestMigrationContaining(marker) {
  const directory = path.join(ROOT, 'supabase', 'migrations');
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      source: fs.readFileSync(path.join(directory, name), 'utf8'),
    }))
    .filter(({ source }) => source.includes(marker));
  assert.ok(candidates.length > 0, `no migration contains: ${marker}`);
  return candidates.at(-1);
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start anchor: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end anchor: ${end}`);
  return source.slice(from, to);
}

function loadAdminPage(sandbox = {}) {
  const context = vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/pages/AdminPage.js')}\n;globalThis.AdminPage = AdminPage;`,
    context,
    { filename: 'public/js/pages/AdminPage.js' },
  );
  return context.AdminPage;
}

const RPC_MARKER =
  'create or replace function public.admin_enrichment_engine_health()';

test('engine health RPC exposes versioned exact-file progress, scheduler health, and bounded states', () => {
  const migration = latestMigrationContaining(RPC_MARKER);
  const rpc = section(
    migration.source,
    RPC_MARKER,
    '\nrevoke all on function public.admin_enrichment_engine_health()',
  );

  assert.match(rpc, /if not public\.is_admin\(\)/);
  assert.match(rpc, /'schema_version'\s*,\s*1/);
  assert.match(rpc, /'window_hours'\s*,\s*24/);
  for (const topLevel of ['generated_at', 'flags', 'scheduler', 'summary', 'rows']) {
    assert.match(rpc, new RegExp(`'${topLevel}'\\s*,`), `missing ${topLevel}`);
  }

  for (const field of [
    'source_id',
    'provider_identity_id',
    'panel',
    'item_type',
    'known_files',
    'probed_files',
    'never_probed_files',
    'probed_files_24h',
    'verified_files',
    'verified_files_24h',
    'resolved_pct',
    'last_probe_at',
    'last_verified_at',
    'progress_scope',
    'next_retry_at',
    'next_run_at',
    'lease_until',
    'last_claimed_at',
    'last_finished_at',
    'consecutive_failures',
    'dispatch_count',
    'last_result_processed',
    'last_result_failed',
    'last_error',
    'state',
    'reason',
  ]) {
    assert.match(rpc, new RegExp(`\\b${field}\\b`), `missing ${field}`);
  }

  // The July cutover moved canonical probe evidence to exact files. Reusing
  // cloud_titles.audio_probed_at would recreate the false "stopped" incident.
  assert.match(rpc, /catalog_file_tracks/);
  assert.match(rpc, /cloud_title_file_language_observations/);
  assert.doesNotMatch(rpc, /\bct\.audio_probed_at\b/);
  // Episode/series retry rows are item-scoped. A single deferred item must
  // never make the whole provider panel look blocked or pushed back.
  assert.doesNotMatch(rpc, /\bcatalog_episode_probe_state\b/);
  assert.doesNotMatch(rpc, /\bcatalog_series_inventory_state\b/);
});

test('engine health RPC keeps every actionable pause, retry, block, and stall reason distinct', () => {
  const migration = latestMigrationContaining(RPC_MARKER);
  const rpc = section(
    migration.source,
    RPC_MARKER,
    '\nrevoke all on function public.admin_enrichment_engine_health()',
  );

  for (const state of [
    'active',
    'running',
    'idle',
    'complete',
    'paused',
    'blocked',
    'retry_wait',
    'stalled',
    'disabled',
    'not_scheduled',
  ]) {
    assert.match(rpc, new RegExp(`'${state}'`), `missing state ${state}`);
  }

  for (const reason of [
    'progressing',
    'lease_active',
    'no_recent_probe',
    'complete',
    'exhausted',
    'no_known_files',
    'enrichment_paused',
    'episode_audio_scan_disabled',
    'live_session',
    'pregen_active',
    'provider_account_busy',
    'provider_background_busy',
    'footprint_budget',
    'rate_limited',
    'circuit_open',
    'authentication',
    'forbidden',
    'worker_error',
    'retry_scheduled',
    'queue_overdue',
    'source_disabled',
    'source_not_ready',
    'schedule_missing',
  ]) {
    assert.match(rpc, new RegExp(`'${reason}'`), `missing reason ${reason}`);
  }
});

test('twelve of thirteen legacy zero-throughput rows are not falsely classified as stalled', () => {
  const AdminPage = loadAdminPage();
  assert.equal(typeof AdminPage.engineState, 'function');

  const cases = [
    ['active', 'progressing'],
    ['running', 'lease_active'],
    ['paused', 'enrichment_paused'],
    ['retry_wait', 'provider_account_busy'],
    ['retry_wait', 'provider_background_busy'],
    ['retry_wait', 'footprint_budget'],
    ['retry_wait', 'rate_limited'],
    ['retry_wait', 'circuit_open'],
    ['blocked', 'authentication'],
    ['blocked', 'forbidden'],
    ['retry_wait', 'retry_scheduled'],
    ['complete', 'exhausted'],
    ['stalled', 'queue_overdue'],
  ];

  const health = AdminPage.normalizeEngineHealth({
    schema_version: 1,
    rows: cases.map(([state, reason], index) => ({
      panel: `fixture-${index + 1}`,
      item_type: index % 2 ? 'series' : 'movie',
      // These legacy counters made every fixture look stopped before the
      // versioned engine-health RPC became authoritative.
      never_probed: 100 + index,
      probed_24h: 0,
      resolved_24h: 0,
      state,
      reason,
      never_probed_files: 100 + index,
      probed_files_24h: state === 'active' ? 7 : 0,
      verified_files_24h: state === 'active' ? 2 : 0,
    })),
  });
  assert.equal(health.available, true);
  assert.equal(health.rows[0].probed_24h, 7);
  assert.equal(health.rows[0].resolved_24h, 2);
  const diagnostics = health.rows.map((row) => AdminPage.engineState(row));

  assert.equal(diagnostics.filter(({ kind }) => kind === 'stalled').length, 1);
  assert.equal(diagnostics.filter(({ kind }) => kind !== 'stalled').length, 12);
  diagnostics.forEach((diagnostic, index) => {
    assert.equal(diagnostic.kind, cases[index][0]);
    assert.equal(diagnostic.reason, cases[index][1]);
  });
});

test('exact progress wins over obsolete title-level zero throughput', () => {
  const AdminPage = loadAdminPage();
  const health = AdminPage.normalizeEngineHealth({
    schema_version: 1,
    rows: [{
      state: 'active',
      reason: 'progressing',
      never_probed: 2747,
      probed_24h: 0,
      resolved_24h: 0,
      never_probed_files: 1900,
      probed_files_24h: 7,
      verified_files_24h: 2,
      last_probe_at: '2026-07-27T10:05:00.000Z',
    }],
  });
  const diagnostic = AdminPage.engineState(health.rows[0]);

  assert.equal(diagnostic.kind, 'active');
  assert.equal(diagnostic.reason, 'progressing');
  assert.notEqual(diagnostic.kind, 'stalled');
});

test('busy and footprint waits stay informational while rate, circuit, auth, and true stalls are actionable', () => {
  const AdminPage = loadAdminPage();
  const fixtures = [
    ['retry_wait', 'provider_account_busy'],
    ['retry_wait', 'provider_background_busy'],
    ['retry_wait', 'footprint_budget'],
    ['retry_wait', 'rate_limited'],
    ['retry_wait', 'circuit_open'],
    ['blocked', 'authentication'],
    ['blocked', 'forbidden'],
    ['paused', 'enrichment_paused'],
    ['stalled', 'queue_overdue'],
  ];
  const health = AdminPage.normalizeEngineHealth({
    schema_version: 1,
    rows: fixtures.map(([state, reason]) => ({
      state,
      reason,
      never_probed_files: 10,
      probed_files_24h: 0,
    })),
  });
  const byReason = new Map(
    health.rows.map((row) => [row.reason, AdminPage.engineStateView(row)]),
  );

  for (const reason of [
    'provider_account_busy',
    'provider_background_busy',
    'footprint_budget',
  ]) {
    assert.equal(byReason.get(reason).informational, true, reason);
    assert.equal(byReason.get(reason).actionable, false, reason);
  }
  for (const reason of [
    'rate_limited',
    'circuit_open',
    'authentication',
    'forbidden',
    'queue_overdue',
  ]) {
    assert.equal(byReason.get(reason).actionable, true, reason);
  }
  assert.equal(byReason.get('enrichment_paused').kind, 'paused');
  assert.equal(byReason.get('enrichment_paused').actionable, false);
  assert.equal(byReason.get('queue_overdue').kind, 'stalled');
});

test('RPC-unavailable fallback never invents a stall from legacy zero throughput', () => {
  const AdminPage = loadAdminPage();
  assert.equal(AdminPage.normalizeEngineHealth(null).available, false);
  assert.equal(
    AdminPage.normalizeEngineHealth({ schema_version: 0, rows: [] }).available,
    false,
  );

  const unknown = AdminPage.engineState({
    panel: 'IPTV Ferran',
    item_type: 'movie',
    never_probed: 2747,
    probed_24h: 0,
    resolved_24h: 0,
  });
  assert.equal(unknown.kind, 'unknown');
  assert.notEqual(unknown.kind, 'stalled');

  const active = AdminPage.engineState({
    never_probed: 2700,
    probed_24h: 47,
    resolved_24h: 8,
  });
  assert.equal(active.kind, 'active');

  const legacyZero = AdminPage.engineState({
    never_probed: 0,
    probed_24h: 0,
    resolved_24h: 0,
  });
  assert.equal(legacyZero.kind, 'unknown');
  assert.notEqual(legacyZero.kind, 'complete');
});

test('Moteur renders fleet blockage and pg_cron failure as distinct incidents', () => {
  const elements = {
    'mot-health': { innerHTML: '' },
    'mot-incidents': { innerHTML: '' },
  };
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
  };
  const AdminPage = loadAdminPage({ document });
  const page = new AdminPage({});
  const health = AdminPage.normalizeEngineHealth({
    schema_version: 1,
    rows: [{
      panel: 'IPTV Ferran',
      item_type: 'movie',
      catalog_titles: 30983,
      known_files: 28000,
      never_probed_files: 2747,
      probed_files_24h: 0,
      verified_files_24h: 0,
      state: 'stalled',
      reason: 'queue_overdue',
    }],
  });
  const crons = [{
    jobname: 'admin-dashboard-refresh',
    active: true,
    fails_24h: 2,
    last_status: 'failed',
  }];

  page._renderEngineHealth(health.rows, crons, {}, health);
  page._renderIncidents(health.rows, crons, health);

  assert.match(elements['mot-health'].innerHTML, /Flotte bloqu\u00e9e/);
  assert.match(elements['mot-health'].innerHTML, /pg_cron KO/);
  assert.match(elements['mot-incidents'].innerHTML, /file de travail en retard/);
  assert.match(elements['mot-incidents'].innerHTML, /pg_cron en \u00e9chec/);
  assert.doesNotMatch(
    elements['mot-health'].innerHTML + elements['mot-incidents'].innerHTML,
    /Sondage \u00e0 l['\u2019]arr\u00eat/,
  );
});

test('legacy fallback renders uncertainty instead of a stopped-probe incident', () => {
  const incidentElement = { innerHTML: '' };
  const document = {
    getElementById: (id) => id === 'mot-incidents' ? incidentElement : null,
    querySelector: () => null,
  };
  const AdminPage = loadAdminPage({ document });
  const page = new AdminPage({});

  page._renderIncidents([{
    panel: 'IPTV Ferran',
    item_type: 'movie',
    never_probed: 2747,
    probed_24h: 0,
    resolved_24h: 0,
  }], [], { available: false });

  assert.match(incidentElement.innerHTML, /Sant\u00e9 d\u00e9taill\u00e9e indisponible/);
  assert.match(
    incidentElement.innerHTML,
    /anciens compteurs portent sur des titres group\u00e9s, pas sur les fichiers exacts/,
  );
  assert.match(incidentElement.innerHTML, /ni \u00e0 une fin de file ni \u00e0 un arr\u00eat/);
  assert.doesNotMatch(incidentElement.innerHTML, /Sondage \u00e0 l['\u2019]arr\u00eat/);
});

test('legacy fallback masks every exact-file counter instead of showing a fake small tail', () => {
  const elements = {
    'mot-health': { innerHTML: '' },
    'admin-enrich': { innerHTML: '' },
  };
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
  };
  const AdminPage = loadAdminPage({ document });
  const page = new AdminPage({});
  page._engineHealth = { available: false };
  const legacyRows = [{
    owner_email: 'audit@example.test',
    panel: 'Legacy panel',
    item_type: 'movie',
    total: 100,
    resolved: 40,
    resolved_pct: 40,
    known_files: 766661,
    never_probed: 766662,
    probed_24h: 766663,
    resolved_24h: 766664,
    subtitle_found: 2,
  }];

  page._renderEngineHealth(legacyRows, [], {}, page._engineHealth);
  page._renderEnrich(legacyRows);

  assert.match(elements['mot-health'].innerHTML, /Progression exacte indisponible/);
  assert.match(elements['mot-health'].innerHTML, /File exacte indisponible/);
  assert.doesNotMatch(elements['mot-health'].innerHTML, /Progression legacy/);
  assert.match(elements['admin-enrich'].innerHTML, /colonnes exactes restent masqu\u00e9es/);
  for (const sentinel of ['766661', '766662', '766663', '766664']) {
    assert.doesNotMatch(elements['admin-enrich'].innerHTML, new RegExp(sentinel));
  }
});

test('exact health renders probed-file coverage instead of obsolete resolved-title coverage', () => {
  const elements = {
    'mot-health': { innerHTML: '' },
    'admin-enrich': { innerHTML: '' },
  };
  const document = {
    getElementById: (id) => elements[id] || null,
    querySelector: () => null,
  };
  const AdminPage = loadAdminPage({ document });
  const page = new AdminPage({});
  const health = AdminPage.normalizeEngineHealth({
    schema_version: 1,
    rows: [{
      owner_email: 'audit@example.test',
      panel: 'Exact panel',
      item_type: 'movie',
      catalog_titles: 1000,
      resolved_titles: 0,
      resolved_pct: 0,
      known_files: 100,
      probed_files: 25,
      never_probed_files: 75,
      probed_files_24h: 4,
      verified_files_24h: 3,
      subtitle_titles: 0,
      state: 'active',
      reason: 'progressing',
    }],
  });
  page._engineHealth = health;

  page._renderEngineHealth(health.rows, [], {}, health);
  page._renderEnrich(health.rows);

  assert.equal(health.rows[0].probed_pct, 25);
  assert.match(elements['mot-health'].innerHTML, />25 %</);
  assert.match(elements['mot-health'].innerHTML, /Fichiers exacts sond\u00e9s/);
  assert.doesNotMatch(elements['mot-health'].innerHTML, />0 %</);
  assert.match(elements['admin-enrich'].innerHTML, /Fichiers sond\u00e9s/);
  assert.match(elements['admin-enrich'].innerHTML, />25 \(25%\)</);
  assert.doesNotMatch(elements['admin-enrich'].innerHTML, /Audio r\u00e9solu/);
});

test('dynamic scheduler issues distinguish missing, disabled, and failed pg_cron without duplicate job names', () => {
  const AdminPage = loadAdminPage();
  const jobname = 'norva-dynamic-enrichment-fleet';
  const health = (scheduler) => ({
    available: true,
    scheduler: { jobname, ...scheduler },
  });

  assert.equal(
    AdminPage.engineSchedulerIssues(health({ present: false }), [])[0].issue,
    'schedule_missing',
  );
  assert.equal(
    AdminPage.engineSchedulerIssues(
      health({ present: true, active: false, last_status: 'succeeded' }),
      [],
    )[0].issue,
    'schedule_disabled',
  );
  assert.equal(
    AdminPage.engineSchedulerIssues(
      health({ present: true, active: true, last_status: 'failed' }),
      [],
    )[0].issue,
    'schedule_failed',
  );

  const duplicateCronFailure = [{
    jobname,
    fails_24h: 1,
    last_status: 'failed',
  }];
  assert.equal(
    AdminPage.engineSchedulerIssues(
      health({ present: true, active: true, last_status: 'failed' }),
      duplicateCronFailure,
    ).length,
    0,
  );

  // A recovered row or another failing job is not the same current failure
  // and must not hide the dynamic scheduler signal.
  assert.equal(
    AdminPage.engineSchedulerIssues(
      health({ present: true, active: true, last_status: 'failed' }),
      [{ jobname, fails_24h: 1, last_status: 'succeeded' }],
    ).length,
    1,
  );
  assert.equal(
    AdminPage.engineSchedulerIssues(
      health({ present: true, active: true, last_status: 'failed' }),
      [{ jobname: 'another-job', fails_24h: 1, last_status: 'failed' }],
    ).length,
    1,
  );
});

test('dynamic scheduler incidents render every transport failure and deduplicate the cron table failure', () => {
  const incidentElement = { innerHTML: '' };
  const document = {
    getElementById: (id) => id === 'mot-incidents' ? incidentElement : null,
    querySelector: () => null,
  };
  const AdminPage = loadAdminPage({ document });
  const page = new AdminPage({});
  const jobname = 'norva-dynamic-enrichment-fleet';
  const render = (scheduler, cronRows = []) => {
    const health = AdminPage.normalizeEngineHealth({
      schema_version: 1,
      scheduler: { jobname, ...scheduler },
      rows: [],
    });
    page._renderIncidents([], cronRows, health);
    return incidentElement.innerHTML;
  };

  for (const [scheduler, expected] of [
    [{ present: false }, 'planification absente'],
    [
      { present: true, active: false, last_status: 'succeeded' },
      'planification d\u00e9sactiv\u00e9e',
    ],
    [
      { present: true, active: true, last_status: 'failed' },
      'dernier run en \u00e9chec',
    ],
  ]) {
    const html = render(scheduler);
    assert.match(html, /pg_cron dynamique/);
    assert.match(html, new RegExp(expected));
    assert.match(html, new RegExp(jobname));
  }

  const duplicate = render(
    { present: true, active: true, last_status: 'failed', failures_24h: 1 },
    [{ jobname, fails_24h: 1, last_status: 'failed' }],
  );
  assert.equal(duplicate.split(jobname).length - 1, 1);
  assert.match(duplicate, /pg_cron en \u00e9chec/);
  assert.doesNotMatch(duplicate, /pg_cron dynamique/);
});

test('Dernier progrès renders probe evidence and never a scheduler completion timestamp', () => {
  const enrichElement = { innerHTML: '' };
  const document = {
    getElementById: (id) => id === 'admin-enrich' ? enrichElement : null,
    querySelector: () => null,
  };
  const AdminPage = loadAdminPage({ document });
  const page = new AdminPage({});
  const health = AdminPage.normalizeEngineHealth({
    schema_version: 1,
    rows: [{
      owner_email: 'audit@example.test',
      panel: 'IPTV Ferran',
      item_type: 'movie',
      catalog_titles: 10,
      known_files: 10,
      resolved_titles: 4,
      resolved_pct: 40,
      never_probed_files: 6,
      probed_files_24h: 1,
      verified_files_24h: 1,
      state: 'active',
      reason: 'progressing',
      last_probe_at: null,
      last_verified_at: '2000-01-02T03:04:05.000Z',
      // A scheduler completion is not catalogue progress and must never win,
      // even when it is more recent than every file-level signal.
      last_finished_at: '2099-12-31T23:59:59.000Z',
    }],
  });
  page._engineHealth = health;
  page._renderEnrich(health.rows);

  assert.match(enrichElement.innerHTML, /Dernier progr\u00e8s/);
  assert.match(enrichElement.innerHTML, /2000/);
  assert.doesNotMatch(enrichElement.innerHTML, /2099/);
});

test('Moteur requests the versioned engine RPC and keeps legacy coverage as an explicit fallback', () => {
  const admin = read('public/js/pages/AdminPage.js');
  const app = read('public/js/app.js');
  const moteur = section(
    admin,
    '// \u2500\u2500 Page: Moteur (enrichment + crons) \u2500\u2500',
    '// \u2500\u2500 Page: T\u00e9l\u00e9m\u00e9trie',
  );
  const enrichRenderer = section(
    admin,
    '    _renderEnrich(rows) {',
    '\n    _renderCron(rows) {',
  );
  assert.match(admin, /this\._rpc\('admin_enrichment_engine_health'\)/);
  assert.match(admin, /admin_enrichment_coverage/);
  assert.match(admin, /engineState\(/);
  assert.match(admin, /engineSchedulerIssues\(/);
  assert.match(admin, /engineHealth\.available/);
  assert.match(app, /AdminPage\.js\?v=110/);
  assert.match(
    enrichRenderer,
    /latest\(r\.last_probe_at,\s*r\.last_verified_at\)/,
  );
  assert.doesNotMatch(enrichRenderer, /last_finished_at/);

  assert.match(moteur, /Flotte bloqu\u00e9e/);
  assert.match(moteur, /pg_cron KO/);
  assert.match(
    moteur,
    /Sant\u00e9 d\u00e9taill\u00e9e indisponible[\s\S]*anciens compteurs portent sur des titres group\u00e9s, pas sur les fichiers exacts/,
  );
  assert.match(moteur, /\? \u00e9tat inconnu \(legacy\)/);
  for (const reasonLabel of [
    'rate-limit provider',
    'circuit ouvert',
    'authentification refus\u00e9e',
    'compte provider occup\u00e9',
  ]) {
    assert.match(moteur, new RegExp(reasonLabel));
  }
  assert.doesNotMatch(moteur, /Sondage \u00e0 l['\u2019]arr\u00eat|\u00e0 l['\u2019]arr\u00eat/i);
});
