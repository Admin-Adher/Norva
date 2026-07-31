// Minimal Revolut statement normalization.
//
// Raw CSV is parsed in memory. Only rows carrying an immutable NORVA- reference
// are returned; all unrelated transactions and free-text columns are discarded.

import { sha256Hex } from "./partners-revolut-business.mjs";

const REFERENCE = /^NORVA-[A-F0-9]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SAFE_TOKEN = /^[^\s\u0000-\u001f\u007f]{8,128}$/u;
const PROVIDER_STATES = new Map([
  ["created", "created"],
  ["cree", "created"],
  ["pending", "pending"],
  ["en_attente", "pending"],
  ["completed", "completed"],
  ["termine", "completed"],
  // The reconciliation SQL uses the same terminal contract as the API
  // adapter: a provider decline is a failed transfer, not a separate state.
  ["declined", "failed"],
  ["refuse", "failed"],
  ["failed", "failed"],
  ["echec", "failed"],
  ["reverted", "reverted"],
  ["annule", "reverted"],
  ["cancelled", "cancelled"],
  ["canceled", "cancelled"],
]);
const HEADER_ALIASES = Object.freeze({
  reference: [
    "reference",
    "payment reference",
    "reference de paiement",
  ],
  providerTransactionId: [
    "transaction id",
    "transaction_id",
    "id",
    "identifiant de transaction",
  ],
  amount: [
    "amount",
    "payment amount",
    "amount (payment currency)",
    "montant",
    "montant (devise de paiement)",
  ],
  currency: [
    "currency",
    "payment currency",
    "devise",
    "devise de paiement",
  ],
  valueDate: [
    "date completed (utc)",
    "completed date",
    "completed at",
    "transaction completed (utc)",
    "value date",
    "date",
    "date de fin (utc)",
    "date de valeur",
  ],
  state: ["state", "transaction status", "status", "etat", "statut"],
});

export class RevolutStatementContractError extends Error {
  constructor(code = "revolut_statement_invalid") {
    super(code);
    this.name = "RevolutStatementContractError";
    this.code = code;
  }
}

export async function normalizeRevolutStatementCsv(
  rawCsv,
  currencyExponents,
) {
  if (
    typeof rawCsv !== "string" ||
    rawCsv.length < 10 ||
    rawCsv.length > 5_000_000 ||
    new TextEncoder().encode(rawCsv).byteLength > 5_000_000 ||
    !isRecord(currencyExponents)
  ) {
    throw new RevolutStatementContractError();
  }
  const { records, indexes } = parseStatementRecords(
    rawCsv.replace(/^\uFEFF/, ""),
  );

  const groups = new Map();
  let ignoredRowCount = 0;
  let norvaRowCount = 0;
  for (const record of records.slice(1)) {
    if (record.every((value) => value.trim() === "")) continue;
    const reference = String(record[indexes.reference] || "")
      .trim()
      .toUpperCase();
    if (!REFERENCE.test(reference)) {
      ignoredRowCount += 1;
      continue;
    }
    const providerTransactionId = String(
      record[indexes.providerTransactionId] || "",
    ).trim();
    const currency = String(record[indexes.currency] || "")
      .trim()
      .toUpperCase();
    const exponent = currencyExponents[currency];
    const valueDate = parseDate(record[indexes.valueDate]);
    const providerState = normalizeProviderState(record[indexes.state]);
    if (
      !SAFE_TOKEN.test(providerTransactionId) ||
      !CURRENCY.test(currency) ||
      !Number.isInteger(exponent) ||
      exponent < 0 ||
      exponent > 6 ||
      !valueDate ||
      !providerState
    ) {
      throw new RevolutStatementContractError(
        "revolut_statement_norva_row_invalid",
      );
    }
    norvaRowCount += 1;
    if (norvaRowCount > 5000) {
      throw new RevolutStatementContractError(
        "revolut_statement_too_many_norva_rows",
      );
    }
    const amountMinor = parseAmountMinor(record[indexes.amount], exponent);
    const normalized = {
      reference,
      provider_transaction_id: providerTransactionId,
      amount_minor: amountMinor,
      currency,
      value_date: valueDate,
      provider_state: providerState,
    };
    const group = groups.get(currency) || [];
    group.push(normalized);
    groups.set(currency, group);
  }
  if (groups.size === 0) {
    throw new RevolutStatementContractError(
      "revolut_statement_has_no_norva_rows",
    );
  }
  const sourceFileHash = await sha256Hex(rawCsv);
  return {
    sourceFileHash,
    ignoredRowCount,
    groups: Array.from(groups, ([currency, rows]) => ({
      currency,
      periodStart: rows
        .map((row) => row.value_date)
        .sort()[0],
      periodEnd: rows
        .map((row) => row.value_date)
        .sort()
        .at(-1),
      rows,
    })),
  };
}

export function buildRevolutManualBatchCsv(rawPayload) {
  if (
    !isRecord(rawPayload) ||
    !isRecord(rawPayload.batch) ||
    !Array.isArray(rawPayload.items) ||
    rawPayload.items.length < 1 ||
    rawPayload.items.length > 5000
  ) {
    throw new RevolutStatementContractError(
      "revolut_manual_batch_payload_invalid",
    );
  }
  const lines = [[
    "Beneficiary token",
    "Destination",
    "Amount",
    "Currency",
    "Reference",
  ]];
  for (const item of rawPayload.items) {
    if (
      !isRecord(item) ||
      typeof item.beneficiary_token_ref !== "string" ||
      !SAFE_TOKEN.test(item.beneficiary_token_ref) ||
      typeof item.destination_masked !== "string" ||
      item.destination_masked.length < 4 ||
      item.destination_masked.length > 64 ||
      !Number.isSafeInteger(item.amount_minor) ||
      item.amount_minor < 1 ||
      typeof item.currency !== "string" ||
      !CURRENCY.test(item.currency) ||
      !Number.isInteger(item.currency_exponent) ||
      item.currency_exponent < 0 ||
      item.currency_exponent > 6 ||
      typeof item.reference !== "string" ||
      !REFERENCE.test(item.reference)
    ) {
      throw new RevolutStatementContractError(
        "revolut_manual_batch_payload_invalid",
      );
    }
    lines.push([
      safeSpreadsheetCell(item.beneficiary_token_ref),
      safeSpreadsheetCell(item.destination_masked),
      formatMinor(item.amount_minor, item.currency_exponent),
      item.currency,
      item.reference,
    ]);
  }
  return `${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function parseStatementRecords(value) {
  const structurallyValid = [];
  const headerValid = [];
  for (const delimiter of [",", ";", "\t"]) {
    try {
      const records = parseCsv(value, delimiter);
      if (records.length < 2 || records.length > 50_001) continue;
      structurallyValid.push({ records, delimiter });
      try {
        headerValid.push({
          records,
          indexes: resolveStatementIndexes(records[0]),
          delimiter,
        });
      } catch {
        // Preserve a specific column error below when only one delimiter is
        // structurally possible. Otherwise fail as ambiguous/unsupported.
      }
    } catch {
      // Candidate delimiter does not describe a rectangular CSV document.
    }
  }
  if (headerValid.length === 1) return headerValid[0];
  if (headerValid.length > 1 || structurallyValid.length !== 1) {
    throw new RevolutStatementContractError(
      "revolut_statement_delimiter_invalid",
    );
  }
  return {
    records: structurallyValid[0].records,
    indexes: resolveStatementIndexes(structurallyValid[0].records[0]),
    delimiter: structurallyValid[0].delimiter,
  };
}

function resolveStatementIndexes(rawHeader) {
  const header = rawHeader.map(normalizeHeader);
  return Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([field, aliases]) => {
      const matches = header
        .map((name, index) => aliases.includes(name) ? index : -1)
        .filter((index) => index >= 0);
      if (matches.length !== 1) {
        throw new RevolutStatementContractError(
          `revolut_statement_${field}_column_invalid`,
        );
      }
      return [field, matches[0]];
    }),
  );
}

function parseCsv(value, delimiter) {
  if (![",", ";", "\t"].includes(delimiter)) {
    throw new RevolutStatementContractError();
  }
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === '"' && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field !== "") {
        throw new RevolutStatementContractError();
      }
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new RevolutStatementContractError();
  if (field !== "" || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const width = rows[0]?.length;
  if (
    !Number.isInteger(width) ||
    width < 5 ||
    rows.some((candidate) => candidate.length !== width)
  ) {
    throw new RevolutStatementContractError();
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ");
}

function normalizeProviderState(value) {
  const state = normalizeHeader(value).replace(/\s+/g, "_");
  return PROVIDER_STATES.get(state) || null;
}

function parseAmountMinor(value, exponent) {
  const cleaned = String(value || "")
    .trim()
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "");
  if (!/^-?\d+(?:[.,]\d+)?$/.test(cleaned)) {
    throw new RevolutStatementContractError(
      "revolut_statement_amount_invalid",
    );
  }
  const normalized = cleaned.replace(",", ".");
  const negative = normalized.startsWith("-");
  if (!negative) {
    throw new RevolutStatementContractError(
      "revolut_statement_amount_direction_invalid",
    );
  }
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > exponent) {
    throw new RevolutStatementContractError(
      "revolut_statement_amount_invalid",
    );
  }
  const minorText = `${whole}${fraction.padEnd(exponent, "0")}`
    .replace(/^0+(?=\d)/, "");
  const amount = Number(minorText || "0");
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new RevolutStatementContractError(
      "revolut_statement_amount_invalid",
    );
  }
  return amount;
}

function parseDate(value) {
  const cleaned = String(value || "").trim();
  const iso = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) return validIsoDate(iso[1], iso[2], iso[3]);
  const european = cleaned.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s.*)?$/);
  if (european) {
    return validIsoDate(european[3], european[2], european[1]);
  }
  return null;
}

function validIsoDate(year, month, day) {
  const value = `${year}-${month}-${day}`;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function formatMinor(amountMinor, exponent) {
  const digits = String(amountMinor);
  if (exponent === 0) return digits;
  const padded = digits.padStart(exponent + 1, "0");
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

function safeSpreadsheetCell(value) {
  const text = String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
