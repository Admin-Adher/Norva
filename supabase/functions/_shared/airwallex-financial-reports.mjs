// Strict Airwallex Transaction Reconciliation Report boundary.
//
// Provider contracts:
// - Financial Reports API version 2024-04-30.
// - Transaction Reconciliation Report version 1.1.0.
//
// Airwallex publishes the report fields but not the complete physical CSV
// layout. Norva therefore supports one explicit, versioned layout and requires
// an independent Finance approval recorded in PostgreSQL before this parser is
// allowed to influence a payout. Unknown layouts, columns or values fail
// closed. Raw rows (which may contain beneficiary PII) are never returned.

export const AIRWALLEX_FINANCIAL_REPORTS_API_VERSION = "2024-04-30";
export const AIRWALLEX_TRANSACTION_REPORT_VERSION = "1.1.0";
export const AIRWALLEX_TRANSACTION_REPORT_CONTRACT =
  "transaction_recon_csv_1_1_0_preamble_v1";
export const AIRWALLEX_TRANSACTION_REPORT_TYPE = "TRANSACTION_RECON_REPORT";

export const AIRWALLEX_TRANSACTION_COLUMNS = Object.freeze([
  "Type",
  "Transaction Id",
  "Financial Transaction Type",
  "Source Id",
  "Source Entity",
  "Request Id",
  "Created At",
  "Estimated settled At",
  "Settled At",
  "Status",
  "Settlement Currency",
  "Settlement Amount",
  "Fee",
  "Net Amount",
  "Transaction Currency",
  "Transaction Amount",
  "Exchange Rate",
  "Settlement Type",
  "Batch Id",
  "Payment Method",
  "Payment Attempt Id",
  "Payment Intent Id",
  "Order Id",
  "Reference",
  "Reason",
  "Note",
  "Beneficiary Name",
  "Beneficiary Bank Account Number",
  "Remitting Bank",
  "Remitter Name",
]);

const REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,50}$/;
const DISPATCH_KEY_RE = /^pds_[0-9a-f]{24}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const MAX_FIELD_CHARS = 16 * 1024;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 10_000;

export class AirwallexReportContractError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = "AirwallexReportContractError";
    this.code = /^[a-z0-9][a-z0-9._-]{1,63}$/.test(String(code ?? ""))
      ? code
      : "invalid_report_contract";
    this.retryable = options.retryable === true;
  }
}

export function loadAirwallexFinancialReportsConfig(get) {
  const configuredApiVersion = cleanText(
    get("AIRWALLEX_FINANCIAL_REPORTS_API_VERSION"),
    10,
  );
  const configuredReportVersion = cleanText(
    get("AIRWALLEX_TRANSACTION_REPORT_VERSION"),
    16,
  );
  const configuredContract = cleanText(
    get("AIRWALLEX_TRANSACTION_REPORT_CONTRACT"),
    80,
  );
  const enabled = String(
    get("AIRWALLEX_FINANCIAL_REPORTS_ENABLED") ?? "",
  ).trim().toLowerCase();

  if (!enabled) return null;
  if (
    enabled !== "true" ||
    configuredApiVersion !== AIRWALLEX_FINANCIAL_REPORTS_API_VERSION ||
    configuredReportVersion !== AIRWALLEX_TRANSACTION_REPORT_VERSION ||
    configuredContract !== AIRWALLEX_TRANSACTION_REPORT_CONTRACT
  ) {
    throw new AirwallexReportContractError(
      "airwallex_reports_not_configured",
    );
  }

  return Object.freeze({
    apiVersion: AIRWALLEX_FINANCIAL_REPORTS_API_VERSION,
    reportVersion: AIRWALLEX_TRANSACTION_REPORT_VERSION,
    contractVersion: AIRWALLEX_TRANSACTION_REPORT_CONTRACT,
    timezone: "UTC",
    lookbackDays: boundedInt(
      get("AIRWALLEX_FINANCIAL_REPORTS_LOOKBACK_DAYS"),
      35,
      2,
      35,
    ),
    maxBytes: boundedInt(
      get("AIRWALLEX_FINANCIAL_REPORTS_MAX_BYTES"),
      DEFAULT_MAX_BYTES,
      64 * 1024,
      8 * 1024 * 1024,
    ),
    maxRows: boundedInt(
      get("AIRWALLEX_FINANCIAL_REPORTS_MAX_ROWS"),
      DEFAULT_MAX_ROWS,
      1,
      25_000,
    ),
    maxMatches: boundedInt(
      get("AIRWALLEX_FINANCIAL_REPORTS_MAX_MATCHES"),
      250,
      1,
      250,
    ),
  });
}

export function buildTransactionReportRequest({
  fromDate,
  toDate,
  fileName,
}) {
  assertDateRange(fromDate, toDate);
  if (
    typeof fileName !== "string" ||
    !/^NORVA_TRANSACTION_RECON_\d{4}_\d{2}_\d{2}_[0-9a-f]{12}\.csv$/.test(
      fileName,
    )
  ) {
    throw new AirwallexReportContractError("invalid_report_file_name");
  }
  return {
    file_format: "CSV",
    file_name: fileName,
    from_created_at: fromDate,
    report_version: AIRWALLEX_TRANSACTION_REPORT_VERSION,
    statuses: ["SETTLED"],
    timezone: "UTC",
    to_created_at: toDate,
    transaction_types: ["PAYOUT"],
    type: AIRWALLEX_TRANSACTION_REPORT_TYPE,
  };
}

export function sanitizeFinancialReport(raw, expected) {
  const report = recordOrNull(raw);
  const parameters = recordOrNull(report?.report_parameters);
  const id = cleanText(report?.id, 128);
  const fileName = cleanText(report?.file_name, 255);
  const status = cleanText(report?.status, 16)?.toUpperCase();
  const type = cleanText(report?.type, 48)?.toUpperCase();
  const fileFormat = cleanText(report?.file_format, 16)?.toUpperCase();
  const reportVersion = cleanText(report?.report_version, 16);
  const fromCreatedAt = cleanText(parameters?.from_created_at, 32);
  const toCreatedAt = cleanText(parameters?.to_created_at, 32);
  const timezone = cleanText(
    parameters?.time_zone ?? parameters?.timezone,
    64,
  );
  const transactionTypes = normalizeUpperArray(
    parameters?.transaction_types,
  );

  if (
    !id ||
    !REPORT_ID_RE.test(id) ||
    !fileName ||
    !status ||
    !["PENDING", "COMPLETED"].includes(status) ||
    type !== AIRWALLEX_TRANSACTION_REPORT_TYPE ||
    fileFormat !== "CSV" ||
    reportVersion !== AIRWALLEX_TRANSACTION_REPORT_VERSION ||
    !fromCreatedAt ||
    !toCreatedAt ||
    timezone !== "UTC" ||
    !transactionTypes ||
    transactionTypes.length !== 1 ||
    transactionTypes[0] !== "PAYOUT"
  ) {
    throw new AirwallexReportContractError("invalid_report_response");
  }

  if (
    expected &&
    (
      fileName !== expected.fileName ||
      fromCreatedAt.slice(0, 10) !== expected.fromDate ||
      toCreatedAt.slice(0, 10) !== expected.toDate
    )
  ) {
    throw new AirwallexReportContractError("report_response_mismatch");
  }

  return Object.freeze({
    id,
    fileName,
    status,
    fromDate: fromCreatedAt.slice(0, 10),
    toDate: toCreatedAt.slice(0, 10),
  });
}

export function isApprovedReportContract(raw, expectedEnvironment) {
  const contract = recordOrNull(raw);
  return contract?.approved === true &&
    contract?.contract_version === AIRWALLEX_TRANSACTION_REPORT_CONTRACT &&
    contract?.api_version === AIRWALLEX_FINANCIAL_REPORTS_API_VERSION &&
    contract?.report_version === AIRWALLEX_TRANSACTION_REPORT_VERSION &&
    contract?.environment === expectedEnvironment &&
    typeof contract?.approved_at === "string" &&
    Number.isFinite(Date.parse(contract.approved_at));
}

export async function parseTransactionReconciliationCsv(
  bytes,
  {
    fromDate,
    toDate,
    candidates,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRows = DEFAULT_MAX_ROWS,
    maxMatches = 100,
  },
) {
  assertDateRange(fromDate, toDate);
  const input = toUint8Array(bytes);
  if (
    input.byteLength < 16 ||
    input.byteLength > maxBytes ||
    input.includes(0)
  ) {
    throw new AirwallexReportContractError("invalid_report_size");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new AirwallexReportContractError("invalid_report_encoding");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = parseCsv(text, maxRows + 32);
  const headerIndexes = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (arraysEqual(rows[index], AIRWALLEX_TRANSACTION_COLUMNS)) {
      headerIndexes.push(index);
    }
  }
  if (headerIndexes.length !== 1) {
    throw new AirwallexReportContractError("invalid_report_header");
  }
  const headerIndex = headerIndexes[0];
  validatePreamble(rows.slice(0, headerIndex), fromDate, toDate);

  const candidateMap = validateCandidates(candidates, fromDate, toDate);
  const matches = [];
  const seenRequestIds = new Set();
  let dataRowCount = 0;
  let settledPayoutRowCount = 0;

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (isBlankRow(row)) continue;
    dataRowCount += 1;
    if (dataRowCount > maxRows) {
      throw new AirwallexReportContractError("report_row_limit");
    }
    if (row.length !== AIRWALLEX_TRANSACTION_COLUMNS.length) {
      throw new AirwallexReportContractError("invalid_report_row");
    }
    const requestId = row[5];
    const candidate = candidateMap.get(requestId);
    if (!candidate) continue;
    if (seenRequestIds.has(requestId)) {
      throw new AirwallexReportContractError("duplicate_report_request");
    }
    seenRequestIds.add(requestId);

    if (
      row[0] !== "Payout" ||
      row[2] !== "Payout" ||
      row[4] !== "Payout" ||
      row[9] !== "Settled"
    ) {
      throw new AirwallexReportContractError("payout_row_mismatch");
    }
    settledPayoutRowCount += 1;
    if (!safeProviderText(row[1]) || !safeProviderText(row[3])) {
      throw new AirwallexReportContractError("invalid_report_reference");
    }
    if (row[3] !== candidate.providerTransferId) {
      throw new AirwallexReportContractError(
        "report_provider_transfer_mismatch",
      );
    }

    const createdAt = parseReportDateTime(row[6]);
    const settledAt = parseReportDateTime(row[8]);
    if (
      !createdAt ||
      !settledAt ||
      createdAt.date < fromDate ||
      createdAt.date > toDate ||
      settledAt.millis > Date.now() + 24 * 60 * 60 * 1000
    ) {
      throw new AirwallexReportContractError("invalid_report_timestamp");
    }

    const transactionCurrency = row[14].trim().toUpperCase();
    const transactionAmount = row[15].trim();
    const usesTransactionAmount = transactionCurrency !== "" ||
      transactionAmount !== "";
    if (
      usesTransactionAmount &&
      (!/^[A-Z]{3}$/.test(transactionCurrency) || !transactionAmount)
    ) {
      throw new AirwallexReportContractError("incomplete_transaction_amount");
    }
    const currency = usesTransactionAmount
      ? transactionCurrency
      : row[10].trim().toUpperCase();
    const decimalAmount = usesTransactionAmount
      ? transactionAmount
      : row[11].trim();
    const amountMinor = decimalToMinor(
      decimalAmount,
      candidate.currencyExponent,
    );
    if (
      currency !== candidate.currency ||
      amountMinor !== candidate.amountMinor
    ) {
      throw new AirwallexReportContractError("payout_amount_mismatch");
    }

    const canonicalEvidence = [
      AIRWALLEX_TRANSACTION_REPORT_VERSION,
      row[1],
      row[2],
      row[3],
      requestId,
      row[8],
      currency,
      String(amountMinor),
    ].join("\u001f");
    const proofHash = await sha256Hex(canonicalEvidence);
    const referenceHash = await sha256Hex(
      `airwallex:transaction:${row[1]}`,
    );
    matches.push(Object.freeze({
      dispatchKey: candidate.dispatchKey,
      providerTransferId: candidate.providerTransferId,
      settlementReference: `airwallex-transaction-${
        referenceHash.slice(0, 40)
      }`,
      proofHash,
      amountMinor,
      currency,
      valueDate: settledAt.date,
      observedAt: new Date().toISOString(),
    }));
    if (matches.length > maxMatches) {
      throw new AirwallexReportContractError("report_match_limit");
    }
  }

  return Object.freeze({
    rowCount: dataRowCount,
    candidateCount: candidateMap.size,
    matchedCount: matches.length,
    unmatchedCount: candidateMap.size - matches.length,
    settledPayoutRowCount,
    matches: Object.freeze(matches),
  });
}

export function decimalToMinor(value, exponent) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 6 ||
    !/^-?\d{1,16}(?:\.\d{1,6})?$/.test(raw)
  ) {
    throw new AirwallexReportContractError("invalid_report_amount");
  }
  if (raw.startsWith("-")) {
    throw new AirwallexReportContractError("invalid_report_amount");
  }
  const [wholeRaw, fractionRaw = ""] = raw.split(".");
  if (fractionRaw.length > exponent) {
    const overflow = fractionRaw.slice(exponent);
    if (!/^0*$/.test(overflow)) {
      throw new AirwallexReportContractError("report_amount_precision");
    }
  }
  const fraction = fractionRaw.slice(0, exponent).padEnd(exponent, "0");
  const normalizedWhole = wholeRaw.replace(/^0+(?=\d)/, "");
  const minor = BigInt(`${normalizedWhole}${fraction}` || "0");
  if (minor < 1n || minor > 9007199254740991n) {
    throw new AirwallexReportContractError("invalid_report_amount");
  }
  return Number(minor);
}

export async function sha256Bytes(bytes) {
  const input = toUint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return hex(digest);
}

function validatePreamble(rows, fromDate, toDate) {
  const expected = new Map([
    ["Account Name", null],
    ["Account Id", null],
    ["Time Zone", "UTC"],
    ["Date Range", "Created at"],
    ["From Date", fromDate],
    ["To Date", toDate],
  ]);
  const found = new Map();
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const field = row[0]?.trim();
    if (!expected.has(field)) continue;
    if (found.has(field) || row.length < 2 || row.slice(2).some(Boolean)) {
      throw new AirwallexReportContractError("invalid_report_preamble");
    }
    const value = row[1].trim();
    if (!value) {
      throw new AirwallexReportContractError("invalid_report_preamble");
    }
    found.set(field, value);
  }
  for (const [field, expectedValue] of expected) {
    const actual = found.get(field);
    if (!actual) {
      throw new AirwallexReportContractError("incomplete_report_preamble");
    }
    if (
      expectedValue === "UTC" && actual !== "UTC" ||
      expectedValue === "Created at" && actual !== "Created at" ||
      DATE_RE.test(String(expectedValue)) &&
        !actual.startsWith(`${expectedValue} `)
    ) {
      throw new AirwallexReportContractError("report_period_mismatch");
    }
  }
}

function validateCandidates(candidates, fromDate, toDate) {
  if (!Array.isArray(candidates) || candidates.length > 250) {
    throw new AirwallexReportContractError("invalid_report_candidates");
  }
  const map = new Map();
  for (const raw of candidates) {
    const candidate = recordOrNull(raw);
    const dispatchKey = cleanText(candidate?.dispatch_key, 64)?.toLowerCase();
    const requestId = cleanText(candidate?.request_id, 50);
    const providerTransferId = cleanText(
      candidate?.provider_transfer_id,
      128,
    );
    const amountMinor = Number(candidate?.amount_minor);
    const currency = cleanText(candidate?.currency, 3)?.toUpperCase();
    const currencyExponent = Number(candidate?.currency_exponent);
    const createdAt = cleanText(candidate?.created_at, 64);
    const createdDate = createdAt?.slice(0, 10);
    if (
      !dispatchKey ||
      !DISPATCH_KEY_RE.test(dispatchKey) ||
      !requestId ||
      !REQUEST_ID_RE.test(requestId) ||
      !providerTransferId ||
      !REPORT_ID_RE.test(providerTransferId) ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor < 1 ||
      !currency ||
      !/^[A-Z]{3}$/.test(currency) ||
      !Number.isInteger(currencyExponent) ||
      currencyExponent < 0 ||
      currencyExponent > 6 ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !DATE_RE.test(String(createdDate)) ||
      createdDate < fromDate ||
      createdDate > toDate ||
      map.has(requestId)
    ) {
      throw new AirwallexReportContractError("invalid_report_candidates");
    }
    map.set(
      requestId,
      Object.freeze({
        dispatchKey,
        requestId,
        providerTransferId,
        amountMinor,
        currency,
        currencyExponent,
      }),
    );
  }
  return map;
}

function parseCsv(text, maxPhysicalRows) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += char;
      }
    } else if (closedQuote) {
      if (char === ",") {
        row.push(field);
        field = "";
        closedQuote = false;
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        closedQuote = false;
        if (rows.length > maxPhysicalRows) {
          throw new AirwallexReportContractError("report_row_limit");
        }
      } else {
        throw new AirwallexReportContractError("invalid_report_csv");
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length > maxPhysicalRows) {
        throw new AirwallexReportContractError("report_row_limit");
      }
    } else if (char === '"') {
      throw new AirwallexReportContractError("invalid_report_csv");
    } else {
      field += char;
    }
    if (field.length > MAX_FIELD_CHARS) {
      throw new AirwallexReportContractError("report_field_too_large");
    }
  }
  if (quoted) {
    throw new AirwallexReportContractError("invalid_report_csv");
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseReportDateTime(value) {
  const match = REPORT_DATETIME_RE.exec(String(value ?? "").trim());
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
  const millis = Date.parse(iso);
  if (
    !Number.isFinite(millis) ||
    new Date(millis).toISOString() !== iso
  ) return null;
  return { millis, date: match[1], iso };
}

function assertDateRange(fromDate, toDate) {
  if (!isDate(fromDate) || !isDate(toDate)) {
    throw new AirwallexReportContractError("invalid_report_period");
  }
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  const days = Math.floor((to - from) / 86_400_000);
  if (days < 1 || days > 35 || to > Date.now() + 86_400_000) {
    throw new AirwallexReportContractError("invalid_report_period");
  }
}

function isDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function normalizeUpperArray(value) {
  if (!Array.isArray(value) || value.length > 32) return null;
  const clean = value.map((item) => cleanText(item, 48)?.toUpperCase());
  return clean.every(Boolean) ? clean : null;
}

function safeProviderText(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean &&
      clean.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(clean)
    ? clean
    : null;
}

function recordOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function arraysEqual(left, right) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isBlankRow(row) {
  return row.every((value) => value === "");
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new AirwallexReportContractError("invalid_report_content");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value)),
  );
  return hex(digest);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function boundedInt(raw, fallback, min, max) {
  const number = Number(raw ?? fallback);
  return Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback;
}
