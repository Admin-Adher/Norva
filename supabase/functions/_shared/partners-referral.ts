import {
  hmacSha256Hex,
  randomHex,
  sha256Hex,
  timingSafeEqualText,
} from "./partners-crypto.ts";

export const REFERRAL_COOKIE_NAME = "__Host-norva_referral";
export const REFERRAL_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFERRAL_INTERNAL_MAX_AGE_SECONDS = 60;

const PUBLIC_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const CLAIM_TOKEN_PATTERN = /^v1\.([0-9a-f]{64})\.([0-9a-f]{64})$/;

export type ReferralResolveInput = {
  code: string;
  networkHash: string;
  userAgentHash: string;
};

export type ReferralClaimResult = {
  schema_version: 1;
  action: "referral_claimed";
  replayed: boolean;
  outcome:
    | "attributed"
    | "already_attributed"
    | "ineligible"
    | "expired"
    | "invalid";
  terminal: boolean;
  attribution: {
    status: "attributed";
    attributed_at: string;
  } | null;
};

export class ReferralContractError extends Error {
  constructor(message = "Invalid referral contract") {
    super(message);
    this.name = "ReferralContractError";
  }
}

export function loadReferralSecrets(
  get: (name: string) => string | undefined,
): { edgeHmacSecret: string; cookieSecret: string } | null {
  const edgeHmacSecret = get("NORVA_REFERRAL_EDGE_HMAC_SECRET") ?? "";
  const cookieSecret = get("NORVA_REFERRAL_COOKIE_SECRET") ?? "";
  if (
    !boundedSecret(edgeHmacSecret) ||
    !boundedSecret(cookieSecret) ||
    edgeHmacSecret === cookieSecret
  ) {
    return null;
  }
  return { edgeHmacSecret, cookieSecret };
}

export function parseReferralResolveInput(raw: unknown): ReferralResolveInput {
  const body = exactRecord(raw, ["code", "networkHash", "userAgentHash"]);
  if (
    typeof body.code !== "string" ||
    !PUBLIC_CODE_PATTERN.test(body.code) ||
    typeof body.networkHash !== "string" ||
    !HEX_SHA256_PATTERN.test(body.networkHash) ||
    typeof body.userAgentHash !== "string" ||
    !HEX_SHA256_PATTERN.test(body.userAgentHash)
  ) {
    throw new ReferralContractError();
  }
  return {
    code: body.code,
    networkHash: body.networkHash,
    userAgentHash: body.userAgentHash,
  };
}

export async function assertValidInternalSignature(
  req: Request,
  rawBody: Uint8Array,
  secret: string,
  route: string,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<{ nonceHash: string }> {
  const timestampRaw = req.headers.get("X-Norva-Timestamp") ?? "";
  const nonce = req.headers.get("X-Norva-Nonce") ?? "";
  const signature = (req.headers.get("X-Norva-Signature") ?? "").toLowerCase();
  if (
    !/^\d{10}$/.test(timestampRaw) ||
    !NONCE_PATTERN.test(nonce) ||
    !HEX_SHA256_PATTERN.test(signature)
  ) {
    throw new ReferralContractError();
  }
  const timestamp = Number(timestampRaw);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(nowEpochSeconds - timestamp) > REFERRAL_INTERNAL_MAX_AGE_SECONDS
  ) {
    throw new ReferralContractError();
  }
  const bodyHash = await sha256Hex(rawBody);
  const canonical = [
    timestampRaw,
    nonce,
    req.method,
    route,
    bodyHash,
  ].join("\n");
  const expected = await hmacSha256Hex(secret, canonical);
  if (!timingSafeEqualText(expected, signature)) {
    throw new ReferralContractError();
  }
  return { nonceHash: await sha256Hex(nonce) };
}

export async function newReferralClaim(
  cookieSecret: string,
): Promise<{
  claimHash: string;
  cookieToken: string;
  expiresAt: string;
}> {
  const rawClaim = randomHex(32);
  const prefix = `v1.${rawClaim}`;
  const signature = await hmacSha256Hex(cookieSecret, prefix);
  return {
    claimHash: await sha256Hex(rawClaim),
    cookieToken: `${prefix}.${signature}`,
    expiresAt: new Date(
      Date.now() + REFERRAL_TTL_SECONDS * 1_000,
    ).toISOString(),
  };
}

export async function claimHashFromSignedToken(
  value: unknown,
  cookieSecret: string,
): Promise<string> {
  if (typeof value !== "string") throw new ReferralContractError();
  const match = value.match(CLAIM_TOKEN_PATTERN);
  if (!match) throw new ReferralContractError();
  const expected = await hmacSha256Hex(cookieSecret, `v1.${match[1]}`);
  if (!timingSafeEqualText(expected, match[2])) {
    throw new ReferralContractError();
  }
  return await sha256Hex(match[1]);
}

export function sanitizeReferralResolveRpc(
  raw: unknown,
): { accepted: boolean; expiresAt: string | null } {
  const root = exactRecord(raw, ["schema_version", "accepted", "claim"]);
  if (root.schema_version !== 1 || typeof root.accepted !== "boolean") {
    throw new ReferralContractError();
  }
  if (!root.accepted) {
    if (root.claim !== null) throw new ReferralContractError();
    return { accepted: false, expiresAt: null };
  }
  const claim = exactRecord(root.claim, ["expires_at"]);
  const expiresAt = isoTimestamp(claim.expires_at);
  if (Date.parse(expiresAt) <= Date.now()) throw new ReferralContractError();
  return { accepted: true, expiresAt };
}

export function sanitizeReferralClaimRpc(raw: unknown): ReferralClaimResult {
  const root = exactRecord(raw, [
    "schema_version",
    "action",
    "replayed",
    "outcome",
    "terminal",
    "attribution",
  ]);
  if (
    root.schema_version !== 1 ||
    root.action !== "referral_claimed" ||
    typeof root.replayed !== "boolean" ||
    typeof root.terminal !== "boolean" ||
    ![
      "attributed",
      "already_attributed",
      "ineligible",
      "expired",
      "invalid",
    ].includes(String(root.outcome))
  ) {
    throw new ReferralContractError();
  }
  const outcome = root.outcome as ReferralClaimResult["outcome"];
  let attribution: ReferralClaimResult["attribution"] = null;
  if (root.attribution !== null) {
    const value = exactRecord(root.attribution, ["status", "attributed_at"]);
    if (value.status !== "attributed") throw new ReferralContractError();
    attribution = {
      status: "attributed",
      attributed_at: isoTimestamp(value.attributed_at),
    };
  }
  const successful = outcome === "attributed" ||
    outcome === "already_attributed";
  if (
    root.terminal !== true ||
    successful !== (attribution !== null)
  ) {
    throw new ReferralContractError();
  }
  return {
    schema_version: 1,
    action: "referral_claimed",
    replayed: root.replayed,
    outcome,
    terminal: true,
    attribution,
  };
}

export function parseClaimInput(raw: unknown): { claimToken: string } {
  const body = exactRecord(raw, ["claimToken"]);
  if (
    typeof body.claimToken !== "string" ||
    !CLAIM_TOKEN_PATTERN.test(body.claimToken)
  ) {
    throw new ReferralContractError();
  }
  return { claimToken: body.claimToken };
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
    throw new ReferralContractError();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ReferralContractError();
  }
  return record;
}

function boundedSecret(value: string): boolean {
  return (
    value.length >= 32 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isoTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new ReferralContractError();
  }
  return value;
}
