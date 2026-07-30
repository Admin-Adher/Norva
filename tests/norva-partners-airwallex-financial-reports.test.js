'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!globalThis.crypto) globalThis.crypto = cryptoNode.webcrypto;

const root = path.resolve(__dirname, '..');
const migrationPath =
  'supabase/migrations/20260730100400_partners_airwallex_financial_reports.sql';
const edgePath = 'supabase/functions/norva-partners-payout/index.ts';
const adapterPath =
  'supabase/functions/_shared/partners-airwallex.mjs';
const reportModulePath =
  'supabase/functions/_shared/airwallex-financial-reports.mjs';
const read = (file) => fs
  .readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');
let reportModulePromise;
let adapterModulePromise;
const reports = () => {
  reportModulePromise ??= import(pathToFileURL(
    path.join(root, reportModulePath),
  ).href);
  return reportModulePromise;
};
const adapter = () => {
  adapterModulePromise ??= import(pathToFileURL(
    path.join(root, adapterPath),
  ).href);
  return adapterModulePromise;
};

function reportEnvironment(overrides = {}) {
  const values = {
    AIRWALLEX_FINANCIAL_REPORTS_ENABLED: 'true',
    AIRWALLEX_FINANCIAL_REPORTS_API_VERSION: '2024-04-30',
    AIRWALLEX_TRANSACTION_REPORT_VERSION: '1.1.0',
    AIRWALLEX_TRANSACTION_REPORT_CONTRACT:
      'transaction_recon_csv_1_1_0_preamble_v1',
    ...overrides,
  };
  return (name) => values[name];
}

function airwallexConfig() {
  return {
    provider: 'airwallex',
    environment: 'sandbox',
    baseUrl: 'https://api.sandbox.airwallex.com',
    apiVersion: '2025-06-30',
    clientId: 'client_id_test',
    apiKey: 'api_key_test',
    webhookSecret: 'webhook_secret_test',
    loginAs: null,
    transferReason: 'professional services',
    timeoutMs: 7000,
    webhookToleranceMs: 300000,
  };
}

function utcDate(offsetDays) {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function csvCell(value) {
  const raw = String(value ?? '');
  return /[",\r\n]/.test(raw)
    ? `"${raw.replaceAll('"', '""')}"`
    : raw;
}

function csvRow(values) {
  return values.map(csvCell).join(',');
}

async function validFixture({ duplicate = false, mutateHeader = false } = {}) {
  const { AIRWALLEX_TRANSACTION_COLUMNS } = await reports();
  const fromDate = utcDate(-35);
  const toDate = utcDate(0);
  const createdDate = utcDate(-20);
  const settledDate = utcDate(-18);
  const row = new Array(AIRWALLEX_TRANSACTION_COLUMNS.length).fill('');
  Object.assign(row, {
    0: 'Payout',
    1: 'fin_txn_0123456789abcdef',
    2: 'Payout',
    3: 'transfer_0123456789abcdef',
    4: 'Payout',
    5: 'nv_0123456789abcdef0123456789abcdef',
    6: `${createdDate} 10:00:00`,
    8: `${settledDate} 12:30:00`,
    9: 'Settled',
    10: 'USD',
    11: '6.10',
    12: '0.10',
    13: '6.00',
    14: 'EUR',
    15: '4.99',
    16: '0.818032',
    17: 'Single',
    18: '',
    19: 'LOCAL',
    23: 'NORVA TEST',
    25: 'Internal note that must never leave the parser',
    26: 'Jérémy Hernandez',
    27: 'FR7630006000011234567890189',
  });
  const header = [...AIRWALLEX_TRANSACTION_COLUMNS];
  if (mutateHeader) header[8] = 'Settled on';
  const lines = [
    csvRow(['Account Name', 'Norva']),
    csvRow(['Account Id', 'acct_0123456789abcdef']),
    csvRow(['Time Zone', 'UTC']),
    csvRow(['Date Range', 'Created at']),
    csvRow(['From Date', `${fromDate} 00:00:00`]),
    csvRow(['To Date', `${toDate} 23:59:59`]),
    '',
    csvRow(header),
    csvRow(row),
  ];
  if (duplicate) lines.push(csvRow(row));
  return {
    bytes: new TextEncoder().encode(`${lines.join('\r\n')}\r\n`),
    fromDate,
    toDate,
    candidate: {
      dispatch_key: 'pds_0123456789abcdef01234567',
      request_id: row[5],
      provider_transfer_id: 'transfer_0123456789abcdef',
      amount_minor: 499,
      currency: 'EUR',
      currency_exponent: 2,
      created_at: `${createdDate}T10:00:00.000Z`,
    },
  };
}

test('Financial Reports configuration is explicit, pinned and off by default', async () => {
  const {
    AIRWALLEX_FINANCIAL_REPORTS_API_VERSION,
    AIRWALLEX_TRANSACTION_REPORT_CONTRACT,
    AIRWALLEX_TRANSACTION_REPORT_VERSION,
    loadAirwallexFinancialReportsConfig,
  } = await reports();
  assert.equal(loadAirwallexFinancialReportsConfig(() => undefined), null);
  const config = loadAirwallexFinancialReportsConfig(reportEnvironment());
  assert.equal(config.apiVersion, AIRWALLEX_FINANCIAL_REPORTS_API_VERSION);
  assert.equal(config.reportVersion, AIRWALLEX_TRANSACTION_REPORT_VERSION);
  assert.equal(config.contractVersion, AIRWALLEX_TRANSACTION_REPORT_CONTRACT);
  assert.equal(config.lookbackDays, 35);
  assert.throws(
    () => loadAirwallexFinancialReportsConfig(reportEnvironment({
      AIRWALLEX_FINANCIAL_REPORTS_API_VERSION: '2025-06-30',
    })),
    /airwallex_reports_not_configured/,
  );
  assert.throws(
    () => loadAirwallexFinancialReportsConfig(reportEnvironment({
      AIRWALLEX_FINANCIAL_REPORTS_ENABLED: 'false',
    })),
    /airwallex_reports_not_configured/,
  );
});

test('create contract filters to settled payouts and pins CSV v1.1.0', async () => {
  const { buildTransactionReportRequest } = await reports();
  const fromDate = utcDate(-7);
  const toDate = utcDate(0);
  const request = buildTransactionReportRequest({
    fromDate,
    toDate,
    fileName: `NORVA_TRANSACTION_RECON_${toDate.replaceAll('-', '_')}_0123456789ab.csv`,
  });
  assert.deepEqual(request, {
    file_format: 'CSV',
    file_name:
      `NORVA_TRANSACTION_RECON_${toDate.replaceAll('-', '_')}_0123456789ab.csv`,
    from_created_at: fromDate,
    report_version: '1.1.0',
    statuses: ['SETTLED'],
    timezone: 'UTC',
    to_created_at: toDate,
    transaction_types: ['PAYOUT'],
    type: 'TRANSACTION_RECON_REPORT',
  });
});

test('strict parser returns only minimized matching evidence', async () => {
  const { parseTransactionReconciliationCsv, sha256Bytes } = await reports();
  const fixture = await validFixture();
  const parsed = await parseTransactionReconciliationCsv(fixture.bytes, {
    fromDate: fixture.fromDate,
    toDate: fixture.toDate,
    candidates: [fixture.candidate],
  });
  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.candidateCount, 1);
  assert.equal(parsed.matchedCount, 1);
  assert.equal(parsed.unmatchedCount, 0);
  assert.equal(parsed.matches[0].amountMinor, 499);
  assert.equal(parsed.matches[0].currency, 'EUR');
  assert.match(parsed.matches[0].proofHash, /^[0-9a-f]{64}$/);
  assert.match(
    parsed.matches[0].settlementReference,
    /^airwallex-transaction-[0-9a-f]{40}$/,
  );
  assert.match(await sha256Bytes(fixture.bytes), /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(
    serialized,
    /Jérémy|FR7630006|Internal note|fin_txn_/,
  );
});

test('strict parser rejects schema drift, duplicate/source mismatches and period drift', async () => {
  const { parseTransactionReconciliationCsv } = await reports();
  const changed = await validFixture({ mutateHeader: true });
  await assert.rejects(
    parseTransactionReconciliationCsv(changed.bytes, {
      fromDate: changed.fromDate,
      toDate: changed.toDate,
      candidates: [changed.candidate],
    }),
    /invalid_report_header/,
  );

  const duplicate = await validFixture({ duplicate: true });
  await assert.rejects(
    parseTransactionReconciliationCsv(duplicate.bytes, {
      fromDate: duplicate.fromDate,
      toDate: duplicate.toDate,
      candidates: [duplicate.candidate],
    }),
    /duplicate_report_request/,
  );

  const wrongSource = await validFixture();
  const wrongSourceText = new TextDecoder().decode(wrongSource.bytes)
    .replace(
      'transfer_0123456789abcdef',
      'transfer_fedcba9876543210',
    );
  await assert.rejects(
    parseTransactionReconciliationCsv(
      new TextEncoder().encode(wrongSourceText),
      {
        fromDate: wrongSource.fromDate,
        toDate: wrongSource.toDate,
        candidates: [wrongSource.candidate],
      },
    ),
    /report_provider_transfer_mismatch/,
  );

  const period = await validFixture();
  await assert.rejects(
    parseTransactionReconciliationCsv(period.bytes, {
      fromDate: utcDate(-34),
      toDate: period.toDate,
      candidates: [period.candidate],
    }),
    /report_period_mismatch/,
  );

  const malformed = await validFixture();
  const malformedText = new TextDecoder().decode(malformed.bytes)
    .replace('NORVA TEST', '"NORVA TEST"x');
  await assert.rejects(
    parseTransactionReconciliationCsv(
      new TextEncoder().encode(malformedText),
      {
        fromDate: malformed.fromDate,
        toDate: malformed.toDate,
        candidates: [malformed.candidate],
      },
    ),
    /invalid_report_csv/,
  );
});

test('minor-unit conversion never uses floating point or rounds silently', async () => {
  const { decimalToMinor } = await reports();
  assert.equal(decimalToMinor('4.99', 2), 499);
  assert.equal(decimalToMinor('4.9900', 2), 499);
  assert.equal(decimalToMinor('499', 0), 499);
  assert.throws(() => decimalToMinor('4.999', 2), /report_amount_precision/);
  assert.throws(() => decimalToMinor('-4.99', 2), /invalid_report_amount/);
  assert.throws(() => decimalToMinor('0', 2), /invalid_report_amount/);
});

test('Airwallex client pins report calls and accepts only bounded first-party CSV', async () => {
  const { AirwallexClient } = await adapter();
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/v1/authentication/login')) {
      return new Response(JSON.stringify({
        token: 'access_token_test',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/content')) {
      const body = new TextEncoder().encode('Account Name,Norva\r\n');
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(body.byteLength),
          'content-disposition': 'attachment; filename="report.csv"',
        },
      });
    }
    return new Response(JSON.stringify({
      has_more: false,
      items: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new AirwallexClient(airwallexConfig(), fetchImpl);
  await client.listFinancialReports(0);
  const content = await client.downloadFinancialReportContent(
    'report_0123456789abcdef',
    65536,
  );
  assert.equal(content.contentType, 'text/plain');
  assert.equal(content.contentLength, 20);
  assert.equal(
    calls[1].options.headers['x-api-version'],
    '2024-04-30',
  );
  assert.equal(
    calls[2].options.headers['x-api-version'],
    '2024-04-30',
  );
  assert.equal(calls[2].options.redirect, 'error');
  assert.equal(
    calls[2].url,
    'https://api.sandbox.airwallex.com/api/v1/finance/financial_reports/report_0123456789abcdef/content',
  );
});

test('report download rejects client URLs, MIME drift, length drift and preserves bounded Retry-After', async () => {
  const { AirwallexClient, AirwallexContractError } = await adapter();
  const login = () => new Response(JSON.stringify({
    token: 'access_token_test',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const invalidIdClient = new AirwallexClient(
    airwallexConfig(),
    async () => login(),
  );
  await assert.rejects(
    invalidIdClient.downloadFinancialReportContent(
      'https://attacker.invalid/report.csv',
      65536,
    ),
    /invalid_report_download/,
  );

  let calls = 0;
  const mimeClient = new AirwallexClient(
    airwallexConfig(),
    async () => {
      calls += 1;
      if (calls === 1) return login();
      return new Response('not-a-csv', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  );
  await assert.rejects(
    mimeClient.downloadFinancialReportContent(
      'report_0123456789abcdef',
      65536,
    ),
    /invalid_report_content_type/,
  );

  calls = 0;
  const lengthClient = new AirwallexClient(
    airwallexConfig(),
    async () => {
      calls += 1;
      if (calls === 1) return login();
      return new Response('1234567890123456', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': '17',
        },
      });
    },
  );
  await assert.rejects(
    lengthClient.downloadFinancialReportContent(
      'report_0123456789abcdef',
      65536,
    ),
    /invalid_report_content_length/,
  );

  calls = 0;
  const throttledClient = new AirwallexClient(
    airwallexConfig(),
    async () => {
      calls += 1;
      if (calls === 1) return login();
      return new Response('', {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '125',
        },
      });
    },
  );
  await assert.rejects(
    throttledClient.listFinancialReports(),
    (error) => {
      assert.ok(error instanceof AirwallexContractError);
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 125000);
      return true;
    },
  );
});

test('private state, AAL2 Finance approval, leases and live-off cron are structural invariants', () => {
  const sql = read(migrationPath);
  const edge = read(edgePath);
  const env = read('ops/hetzner/.env.hetzner.example');
  const opsSnapshot = sql.match(
    /create or replace function affiliate_private\.partners_ops_alert_snapshot\(\)[\s\S]*?\n\$\$;/i,
  )?.[0] || '';

  assert.match(
    sql,
    /create table affiliate_private\.affiliate_airwallex_report_contracts/i,
  );
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_airwallex_report_runs/i,
  );
  assert.match(sql, /status\s+text not null default 'draft'/i);
  assert.match(
    sql,
    /partners_require_capability\('finance'\)[\s\S]*auth\.jwt\(\) ->> 'aal'[\s\S]*'aal2'/i,
  );
  assert.match(sql, /force row level security/gi);
  assert.match(
    sql,
    /revoke all on table[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.match(
    sql,
    /partners_worker_airwallex_report_(?:lease|provider_record|candidates|apply|retry)/i,
  );
  assert.match(
    sql,
    /partners_worker_airwallex_report_apply\([\s\S]*for update of run[\s\S]*for update of dispatch[\s\S]*partners_service_airwallex_settlement_observe[\s\S]*status = 'completed'/i,
  );
  assert.match(
    sql,
    /status = 'completed'[\s\S]*matched_count = candidate_count[\s\S]*unmatched_count = 0/i,
  );
  assert.match(
    sql,
    /revoke all on function\s+affiliate_private\.partners_service_airwallex_settlement_observe\([\s\S]*?from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    sql,
    /revoke all on function\s+public\.partners_service_airwallex_settlement_observe\([\s\S]*?from public, anon, authenticated, service_role;/i,
  );
  assert.match(opsSnapshot, /\('payout_report'::text\)/);
  assert.ok(
    (opsSnapshot.match(/\('payout_report'::text\)/g) || []).length >= 2,
    'payout_report must be present in worker state and missing-heartbeat alerts',
  );
  for (const alertCode of [
    'commission_dead_letter',
    'chargeback_reversal_dead_letter',
    'chargeback_reversal_conflict',
    'revenuecat_transfer_dead_letter',
    'revenuecat_transfer_partial_aged',
    'revenuecat_transfer_quarantined_aged',
    'revenuecat_transfer_partner_dead_letter',
    'airwallex_report_exception',
    'airwallex_report_stale',
    'airwallex_report_candidates_unmatched',
    'shadow_reconciliation_mismatch',
    'worker_heartbeat_missing',
  ]) {
    assert.match(opsSnapshot, new RegExp(alertCode));
  }
  assert.match(sql, /airwallex_report_candidates_unmatched/i);
  assert.match(edge, /route === "\/cron\/reports"/);
  assert.match(edge, /await requireCron\(req\)/);
  assert.match(edge, /downloadFinancialReportContent/);
  assert.match(edge, /parsed\.unmatchedCount !== 0/);
  assert.match(edge, /partners_worker_airwallex_report_apply/);
  assert.doesNotMatch(edge, /partners_service_airwallex_settlement_observe/);
  assert.doesNotMatch(edge, /route === "\/settlements\/observe"/);
  assert.doesNotMatch(edge, /downloadUrl|client[_-]?url|req\.json\(\).*reports/is);
  assert.match(env, /AIRWALLEX_FINANCIAL_REPORTS_ENABLED=false/);
  assert.match(env, /AIRWALLEX_FINANCIAL_REPORTS_API_VERSION=2024-04-30/);
});
