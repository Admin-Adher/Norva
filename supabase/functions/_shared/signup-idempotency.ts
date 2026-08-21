// Signup idempotency, which is a different problem from anti-replay.
//
// Anti-replay asks "has this nonce been used before" and feeds the risk score.
// Idempotency asks "what did the first use of it actually do" and feeds the
// response. Conflating them is how a double click becomes two GoTrue calls, a
// "user already exists" error and a second confirmation email — a bug the user
// would see, on a path where the risk verdict is ALLOW and therefore real.
//
// THE FINGERPRINT. The nonce is handed to the browser, so it is not a secret and
// cannot be an HMAC key. The key is a server-only secret and the nonce goes in
// the message:
//
//   HMAC-SHA256(IDEMPOTENCY_SECRET, version | nonce | email | surface | method)
//
// It binds a nonce to the intent it was first used for. The same nonce replayed
// with a different address is not a retry, it is someone reusing a token for
// another signup, and it must never receive the first request's result.
//
// The password is deliberately absent from the fingerprint. It would add nothing
// — the nonce and address already identify the attempt — and it would put a
// credential inside a value that gets stored and logged.

import { canonicalizeRiskSubject } from "./risk-subject-canonical.ts";

/** Bump on key rotation; old fingerprints then stop matching by construction. */
export const FINGERPRINT_VERSION = 1;

const IDEMPOTENCY_SECRET = Deno.env.get("NORVA_SIGNUP_IDEMPOTENCY_SECRET") ?? "";

export function idempotencyConfigured(): boolean {
  return IDEMPOTENCY_SECRET.length >= 32;
}

let macKey: Promise<CryptoKey> | null = null;
function fingerprintKey(): Promise<CryptoKey> {
  if (!macKey) {
    macKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(IDEMPOTENCY_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return macKey;
}

export type SignupSurface = "web" | "mobile" | "tv";
export type SignupAuthMethod = "password" | "magic_link" | "oauth_google";

export interface SignupIntent {
  nonce: string;
  email: string;
  surface: SignupSurface;
  authMethod: SignupAuthMethod;
}

export async function signupRequestFingerprint(intent: SignupIntent): Promise<string> {
  if (!idempotencyConfigured()) throw new Error("idempotency_secret_missing");
  // The same canonicaliser as the velocity store, so "User@X.com " and
  // "user@x.com" are one intent rather than two.
  const email = canonicalizeRiskSubject("email", intent.email);
  if (!email) throw new Error("idempotency_email_invalid");
  if (!/^[0-9a-f]{32}$/.test(intent.nonce)) throw new Error("idempotency_nonce_invalid");

  // Length-prefixed fields, so no combination of values can be rearranged into
  // another valid message. "ab|c" and "a|bc" must not collide.
  const message = [
    FINGERPRINT_VERSION,
    intent.nonce,
    email,
    intent.surface,
    intent.authMethod,
  ].map((part) => {
    const text = String(part);
    return `${text.length}:${text}`;
  }).join("|");

  const mac = await crypto.subtle.sign(
    "HMAC",
    await fingerprintKey(),
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * PROCESSING    the first request holds the claim and is working.
 * SUCCESS       the account exists; the memoised projection is the answer.
 * FAILED_FINAL  it certainly did not succeed, deterministically.
 * UNKNOWN       the upstream call left and its outcome is not known.
 *
 * UNKNOWN is the state that earns its keep. A network timeout after GoTrue has
 * already created the account looks exactly like a failure from here, and
 * calling it FAILED_FINAL would let the retry create a second one — precisely
 * what idempotency exists to prevent. An UNKNOWN attempt is reconciled against
 * the auth side and only then settled.
 */
export type SignupAttemptState = "PROCESSING" | "SUCCESS" | "FAILED_FINAL" | "UNKNOWN";

/**
 * The only fields ever memoised, and the database stores them as three typed
 * columns rather than as a blob. A key allow-list was not enough: it constrains
 * the names of top-level keys, so {"user_id": {"access_token": "..."}} would
 * have passed. A uuid column cannot hold a bearer token however the calling code
 * changes, and a boolean cannot hold a magic link.
 */
export interface SignupResultProjection {
  user_id?: string;
  email_confirmation_required?: boolean;
  created?: boolean;
}

export type SignupClaim =
  | { outcome: "claimed" }
  | {
    outcome: "replay";
    state: SignupAttemptState;
    result: SignupResultProjection | null;
    attemptCount: number;
  }
  // The nonce is known but was first used for a different intent. Never carries
  // a result: returning the first request's answer would hand one person another
  // person's account.
  | { outcome: "intent_mismatch" };

export interface SignupIdempotencyStore {
  claim(nonce: string, fingerprint: string, ttlSeconds: number): Promise<SignupClaim>;
  settle(
    nonce: string,
    fingerprint: string,
    state: Exclude<SignupAttemptState, "PROCESSING">,
    result: SignupResultProjection | null,
    upstreamStatus: number | null,
  ): Promise<boolean>;
}

// deno-lint-ignore no-explicit-any
export function createPostgresIdempotencyStore(db: any): SignupIdempotencyStore {
  return {
    async claim(nonce, fingerprint, ttlSeconds) {
      const { data, error } = await db.rpc("abuse_signup_attempt_claim", {
        p_nonce: nonce,
        p_fingerprint: fingerprint,
        p_fingerprint_version: FINGERPRINT_VERSION,
        p_ttl_seconds: ttlSeconds,
      });
      if (error) throw new Error(`idempotency_claim_failed:${error.code ?? "unknown"}`);
      const row = (data ?? {}) as Record<string, unknown>;
      const outcome = String(row.outcome ?? "");
      if (outcome === "claimed") return { outcome: "claimed" };
      if (outcome === "intent_mismatch") return { outcome: "intent_mismatch" };
      return {
        outcome: "replay",
        state: String(row.state ?? "UNKNOWN") as SignupAttemptState,
        result: (row.result ?? null) as SignupResultProjection | null,
        attemptCount: Number(row.attempt_count ?? 1),
      };
    },
    async settle(nonce, fingerprint, state, result, upstreamStatus) {
      // Spread into typed parameters rather than handing over an object: there is
      // no field here that could carry something the columns cannot hold.
      const { data, error } = await db.rpc("abuse_signup_attempt_settle", {
        p_nonce: nonce,
        p_fingerprint: fingerprint,
        p_state: state,
        p_user_id: result?.user_id ?? null,
        p_email_confirmation_required: result?.email_confirmation_required ?? null,
        p_created: result?.created ?? null,
        p_upstream_status: upstreamStatus,
      });
      if (error) throw new Error(`idempotency_settle_failed:${error.code ?? "unknown"}`);
      return data === true;
    },
  };
}
