#!/usr/bin/env node
'use strict';

// Offline-only approval aid. It reads a Finance-provided Airwallex CSV from
// local disk, validates the pinned physical contract and prints only minimized
// evidence. The CSV, account identifiers and beneficiary fields are never
// uploaded, persisted or printed.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const [filePath, fromDate, toDate] = process.argv.slice(2);
  if (!filePath || !fromDate || !toDate) {
    throw new Error(
      'Usage: node scripts/verify-airwallex-report-contract.js <csv> <from-date> <to-date>',
    );
  }
  const absolutePath = path.resolve(filePath);
  const bytes = fs.readFileSync(absolutePath);
  const report = await import(pathToFileURL(path.resolve(
    __dirname,
    '../supabase/functions/_shared/airwallex-financial-reports.mjs',
  )).href);
  const parsed = await report.parseTransactionReconciliationCsv(bytes, {
    fromDate,
    toDate,
    candidates: [],
  });
  const evidenceHash = await report.sha256Bytes(bytes);
  process.stdout.write(`${JSON.stringify({
    contract_version: report.AIRWALLEX_TRANSACTION_REPORT_CONTRACT,
    api_version: report.AIRWALLEX_FINANCIAL_REPORTS_API_VERSION,
    report_version: report.AIRWALLEX_TRANSACTION_REPORT_VERSION,
    evidence_sha256: evidenceHash,
    bytes: bytes.byteLength,
    rows: parsed.rowCount,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Airwallex report contract validation failed: ${
      String(error?.code ?? error?.message ?? 'unknown')
    }\n`,
  );
  process.exitCode = 1;
});
