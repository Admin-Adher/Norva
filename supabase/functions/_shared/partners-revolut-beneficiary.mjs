const MAX_KEYS_JSON_BYTES = 4096;
const MAX_FINGERPRINT_PAYLOAD_BYTES = 4096;

export class RevolutBeneficiaryContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "RevolutBeneficiaryContractError";
    this.code = code;
  }
}

export function readRevolutBeneficiaryHmacConfig(env) {
  const raw = String(
    env?.get?.("NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_KEYS_JSON") ?? "",
  ).trim();
  if (
    !raw ||
    new TextEncoder().encode(raw).length > MAX_KEYS_JSON_BYTES
  ) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_not_configured",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_config_invalid",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_config_invalid",
    );
  }

  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 8) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_config_invalid",
    );
  }
  const keys = new Map();
  for (const [rawVersion, encodedKey] of entries) {
    if (
      !/^[1-9][0-9]{0,9}$/.test(rawVersion) ||
      typeof encodedKey !== "string" ||
      !/^[A-Za-z0-9_-]{43,86}$/.test(encodedKey)
    ) {
      throw new RevolutBeneficiaryContractError(
        "beneficiary_hmac_config_invalid",
      );
    }
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version > 2147483646) {
      throw new RevolutBeneficiaryContractError(
        "beneficiary_hmac_config_invalid",
      );
    }
    const keyBytes = decodeBase64Url(encodedKey);
    if (keyBytes.length < 32 || keyBytes.length > 64) {
      throw new RevolutBeneficiaryContractError(
        "beneficiary_hmac_config_invalid",
      );
    }
    keys.set(version, keyBytes);
  }
  const rawActiveVersion = String(
    env?.get?.("NORVA_PARTNERS_REVOLUT_BENEFICIARY_HMAC_ACTIVE_VERSION") ?? "",
  ).trim();
  if (!/^[1-9][0-9]{0,9}$/.test(rawActiveVersion)) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_config_invalid",
    );
  }
  const activeVersion = Number(rawActiveVersion);
  if (
    !Number.isSafeInteger(activeVersion) ||
    activeVersion > 2147483646 ||
    !keys.has(activeVersion)
  ) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_config_invalid",
    );
  }
  return Object.freeze({ keys, activeVersion });
}

export async function signRevolutBeneficiaryFingerprint(
  payload,
  keyVersion,
  config,
) {
  if (
    typeof payload !== "string" ||
    payload.length < 1 ||
    new TextEncoder().encode(payload).length > MAX_FINGERPRINT_PAYLOAD_BYTES ||
    !Number.isSafeInteger(keyVersion) ||
    keyVersion < 1 ||
    keyVersion > 2147483646
  ) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_fingerprint_payload_invalid",
    );
  }
  const keyBytes = config?.keys instanceof Map
    ? config.keys.get(keyVersion)
    : null;
  if (!(keyBytes instanceof Uint8Array)) {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_key_unavailable",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToHex(new Uint8Array(signature));
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let decoded;
  try {
    decoded = atob(padded);
  } catch {
    throw new RevolutBeneficiaryContractError(
      "beneficiary_hmac_config_invalid",
    );
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
