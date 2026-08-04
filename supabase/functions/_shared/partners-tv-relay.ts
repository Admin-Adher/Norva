import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualText,
} from "./partners-crypto.ts";

export const PARTNERS_TV_RELAY_RPC = Object.freeze({
  availability: "partners_service_tv_relay_availability",
  create: "partners_service_tv_relay_create",
  status: "partners_service_tv_relay_status",
  consume: "partners_service_tv_relay_consume",
});

const DEVICE_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RELAY_TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{43})\.([0-9a-f]{64})$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
export const PARTNERS_TV_RELAY_HANDOFF_URL = "https://norva.tv/app.html";

export type TvRelayConfig = {
  secret: string;
  handoffUrl: string;
  ttlSeconds: number;
};

export type PreparedTvRelay = {
  relayToken: string;
  relayTokenHash: string;
  requestNonceHash: string;
  expiresAt: string;
  handoffUrl: string;
};

export type TvRelayStatus = {
  schema_version: 1;
  relay: {
    status: "pending" | "consumed" | "expired";
    destination: "partners" | null;
    poll_after_seconds: 3;
  };
};

export type TvRelayAvailability = {
  schema_version: 1;
  availability: {
    enabled: boolean;
    reason: "available" | "feature_disabled" | "not_configured";
  };
};

export type TvRelayConsumeResult = {
  schema_version: 1;
  action: "tv_relay_consumed";
  replayed: boolean;
  relay: {
    status: "consumed";
    destination: "partners";
  };
};

export class TvRelayContractError extends Error {
  constructor(message = "Invalid TV relay contract") {
    super(message);
    this.name = "TvRelayContractError";
  }
}

export function loadTvRelayConfig(
  get: (name: string) => string | undefined,
): TvRelayConfig | null {
  const secret = get("NORVA_PARTNERS_TV_RELAY_SECRET") ?? "";
  const handoffUrl = get("NORVA_PARTNERS_TV_RELAY_HANDOFF_URL") ?? "";
  const ttlRaw = get("NORVA_PARTNERS_TV_RELAY_TTL_SECONDS") ?? "";
  if (
    secret.length < 32 ||
    secret.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(secret) ||
    handoffUrl !== PARTNERS_TV_RELAY_HANDOFF_URL ||
    !/^(?:1[2-9][0-9]|[2-5][0-9]{2}|600)$/.test(ttlRaw)
  ) {
    return null;
  }
  const ttlSeconds = Number(ttlRaw);
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 120 ||
    ttlSeconds > 600
  ) {
    return null;
  }
  return {
    secret,
    handoffUrl: PARTNERS_TV_RELAY_HANDOFF_URL,
    ttlSeconds,
  };
}

export function assertDeviceToken(value: string): void {
  // The existing Norva pairing flow issues exactly 32 random bytes as
  // unpadded base64url, prefixed with nv_dev_. A Supabase user JWT must never
  // be accepted by this boundary.
  if (!/^nv_dev_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TvRelayContractError();
  }
}

export function assertDeviceTokenHash(value: string): void {
  if (!DEVICE_TOKEN_HASH_PATTERN.test(value)) {
    throw new TvRelayContractError();
  }
}

export async function prepareTvRelay(
  config: TvRelayConfig,
  deviceHash: string,
  idempotencyKey: string,
  nowMs = Date.now(),
): Promise<PreparedTvRelay> {
  assertDeviceTokenHash(deviceHash);
  if (
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    throw new TvRelayContractError();
  }

  // Deriving the opaque 32-byte seed from the server secret makes a retried
  // idempotent create return the same bearer token without ever storing that
  // token in PostgreSQL. The signature prevents callers from minting tokens.
  const seedHex = await hmacSha256Hex(
    config.secret,
    `norva-partners-tv-relay:token:v1:${deviceHash}:${idempotencyKey}`,
  );
  const seed = hexToBase64Url(seedHex);
  const prefix = `v1.${seed}`;
  const signature = await hmacSha256Hex(config.secret, prefix);
  const relayToken = `${prefix}.${signature}`;
  const relayTokenHash = await sha256Hex(relayToken);
  const requestNonceHash = await hmacSha256Hex(
    config.secret,
    `norva-partners-tv-relay:nonce:v1:${deviceHash}:${idempotencyKey}`,
  );
  const expiresAt = new Date(
    nowMs + config.ttlSeconds * 1_000,
  ).toISOString();
  return {
    relayToken,
    relayTokenHash,
    requestNonceHash,
    expiresAt,
    // The fragment is never sent in an HTTP request or Referer header. The
    // Web/App-Link landing extracts it client-side after authentication.
    handoffUrl: `${config.handoffUrl}#relay=${encodeURIComponent(relayToken)}`,
  };
}

export async function relayTokenHashFromSignedToken(
  value: unknown,
  secret: string,
): Promise<string> {
  if (typeof value !== "string") throw new TvRelayContractError();
  const match = value.match(RELAY_TOKEN_PATTERN);
  if (!match) throw new TvRelayContractError();
  const prefix = `v1.${match[1]}`;
  const expected = await hmacSha256Hex(secret, prefix);
  if (!timingSafeEqualText(expected, match[2])) {
    throw new TvRelayContractError();
  }
  return await sha256Hex(value);
}

export function parseTvRelayTokenInput(
  raw: unknown,
): { relayToken: string } {
  const body = exactRecord(raw, ["relayToken"]);
  if (
    typeof body.relayToken !== "string" ||
    !RELAY_TOKEN_PATTERN.test(body.relayToken)
  ) {
    throw new TvRelayContractError();
  }
  return { relayToken: body.relayToken };
}

export function sanitizeTvRelayCreateRpc(
  raw: unknown,
  prepared: PreparedTvRelay,
  nowMs = Date.now(),
): Record<string, unknown> {
  const root = exactRecord(raw, ["schema_version", "action", "relay"]);
  const relay = exactRecord(root.relay, [
    "status",
    "expires_at",
    "poll_after_seconds",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "tv_relay_created" ||
    relay.status !== "pending" ||
    relay.poll_after_seconds !== 3
  ) {
    throw new TvRelayContractError();
  }
  const expiresAt = isoTimestamp(relay.expires_at);
  if (
    !Number.isSafeInteger(nowMs) ||
    Date.parse(expiresAt) <= nowMs ||
    Date.parse(expiresAt) > Date.parse(prepared.expiresAt) + 1_000
  ) {
    throw new TvRelayContractError();
  }
  return {
    schema_version: 1,
    action: "tv_relay_created",
    relay: {
      status: "pending",
      relay_token: prepared.relayToken,
      handoff_url: prepared.handoffUrl,
      expires_at: expiresAt,
      poll_after_seconds: 3,
    },
  };
}

export function sanitizeTvRelayAvailabilityRpc(
  raw: unknown,
): TvRelayAvailability {
  const root = exactRecord(raw, ["schema_version", "availability"]);
  const availability = exactRecord(root.availability, ["enabled", "reason"]);
  if (
    root.schema_version !== 1 ||
    typeof availability.enabled !== "boolean" ||
    !["available", "feature_disabled"].includes(String(availability.reason)) ||
    availability.enabled !== (availability.reason === "available")
  ) {
    throw new TvRelayContractError();
  }
  return {
    schema_version: 1,
    availability: {
      enabled: availability.enabled,
      reason: availability.reason as "available" | "feature_disabled",
    },
  };
}

export function localTvRelayUnavailable(): TvRelayAvailability {
  return {
    schema_version: 1,
    availability: {
      enabled: false,
      reason: "not_configured",
    },
  };
}

export function sanitizeTvRelayStatusRpc(raw: unknown): TvRelayStatus {
  const root = exactRecord(raw, ["schema_version", "relay"]);
  const relay = exactRecord(root.relay, [
    "status",
    "destination",
    "poll_after_seconds",
  ]);
  if (
    root.schema_version !== 1 ||
    !["pending", "consumed", "expired"].includes(String(relay.status)) ||
    relay.poll_after_seconds !== 3
  ) {
    throw new TvRelayContractError();
  }
  const status = relay.status as TvRelayStatus["relay"]["status"];
  const destination = relay.destination;
  if (
    (status === "consumed" && destination !== "partners") ||
    (status !== "consumed" && destination !== null)
  ) {
    throw new TvRelayContractError();
  }
  return {
    schema_version: 1,
    relay: {
      status,
      destination: destination as "partners" | null,
      poll_after_seconds: 3,
    },
  };
}

export function sanitizeTvRelayConsumeRpc(
  raw: unknown,
): TvRelayConsumeResult {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "relay",
  ]);
  const relay = exactRecord(root.relay, ["status", "destination"]);
  if (
    root.schema_version !== 1 ||
    root.action !== "tv_relay_consumed" ||
    typeof root.replayed !== "boolean" ||
    relay.status !== "consumed" ||
    relay.destination !== "partners"
  ) {
    throw new TvRelayContractError();
  }
  return {
    schema_version: 1,
    action: "tv_relay_consumed",
    replayed: root.replayed,
    relay: {
      status: "consumed",
      destination: "partners",
    },
  };
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TvRelayContractError();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TvRelayContractError();
  }
  return record;
}

function isoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TvRelayContractError();
  }
  return value;
}

function hexToBase64Url(value: string): string {
  if (!DEVICE_TOKEN_HASH_PATTERN.test(value)) {
    throw new TvRelayContractError();
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
