// Velocity store for the anti-abuse engine — the only thing in the stack that
// knows how often a subject has been seen.
//
// It counts and returns counts. It has no thresholds, no verdicts and no opinion
// about what "too many" means: that belongs to the risk engine and to its
// configuration, so an attack is answered by changing a number rather than by
// deploying code.
//
// PSEUDONYMISATION. Callers pass raw subjects — an IP, an email, a device id —
// and this module is the single place that turns them into identifiers. Nothing
// raw reaches the database. The construction is HMAC-SHA256 under a secret key,
// not a hash: a bare sha256 of an IPv4 address is an encoding rather than a
// pseudonym, since 2^32 candidates fall to a GPU in seconds and any email in a
// breach corpus falls faster. A keyed MAC is the standard answer to exactly
// this, and it leaves no length-extension surface. The key lives only in the
// environment; someone holding a copy of the table, or a backup of it, can
// recover nothing by dictionary attack. HASH_VERSION travels with every row so
// the key can be rotated on a schedule — after a rotation the old counters stop
// matching, which is the point.
//
// SUBSTITUTABILITY. The interface is deliberately narrow — one method, subjects
// in, counts out — so a Redis-backed implementation can take over one dimension
// at a time if Norva's volume ever justifies it, without the engine noticing.
// Postgres is the right answer today: the atomicity is already there, there is
// no Redis in this architecture, and adding one would add a point of failure to
// the signup path for no present gain.
//
// FAILURE MODE. This module surfaces errors rather than swallowing them, but the
// engine treats a failure as "no velocity signal" and proceeds — a broken
// counter must never stop a legitimate person from creating an account. The Kong
// floor stays underneath as the hard ceiling while that is true.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { canonicalizeRiskSubject } from "./risk-subject-canonical.ts";

// Adding a dimension means teaching the engine to compute it, so the list is
// code and mirrors the check constraint in the migration.
export type VelocityDimension =
  | "ip"
  | "ip_subnet_24"
  | "ip_subnet_64"
  | "asn"
  | "email"
  | "mailbox_subject"
  | "device"
  | "user_agent";

export interface VelocityQuery {
  dimension: VelocityDimension;
  /** Raw value. Hashed here; never sent or logged as-is. */
  subject: string;
  /** Windows to report, in seconds. <= 3600 reads minute buckets, above reads hours. */
  windowsSeconds: number[];
}

export interface VelocityReading {
  dimension: VelocityDimension;
  /** Keyed by window in seconds, as requested. */
  counts: Record<number, number>;
}

export interface RiskVelocityStore {
  /**
   * Record one occurrence of every supplied subject and return their counts.
   * A single round trip: the signup path cannot afford one per dimension.
   */
  touch(queries: VelocityQuery[]): Promise<VelocityReading[]>;
}

/** Matches the bounded fan-out enforced by the SQL function. */
export const MAX_VELOCITY_ENTRIES = 16;

/** Bump on key rotation. Stored per row so a retired generation is prunable. */
export const HASH_VERSION = 1;

// NORVA_ABUSE_HASH_KEY is the name going forward; NORVA_ABUSE_HASH_SALT is
// accepted because it is already deployed, and the value serves either way.
const HASH_KEY = Deno.env.get("NORVA_ABUSE_HASH_KEY")
  ?? Deno.env.get("NORVA_ABUSE_HASH_SALT")
  ?? "";

export function velocityHashingConfigured(): boolean {
  // A short key is worse than an obvious absence, because it looks configured.
  return HASH_KEY.length >= 32;
}

// Importing the key per call would cost a few hundred microseconds on the signup
// path for no reason. Imported once, lazily, so a missing key still throws from
// hashSubject rather than at module load.
let macKey: Promise<CryptoKey> | null = null;
function hmacKey(): Promise<CryptoKey> {
  if (!macKey) {
    macKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(HASH_KEY),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return macKey;
}

/**
 * Keyed, normalised subject identifier. Normalisation matters as much as the
 * key: "User@Example.COM " and "user@example.com" are one person, and counting
 * them as two is how an email-rotation limit gets bypassed for free.
 */
export async function hashSubject(
  dimension: VelocityDimension,
  subject: string,
): Promise<string> {
  if (!velocityHashingConfigured()) {
    throw new Error("velocity_key_missing");
  }
  // Canonical first, always. Two spellings of one address must not become two
  // subjects, and an unparseable value is refused rather than counted: a missing
  // signal costs a little accuracy, a wrong subject costs a real user.
  const canonical = canonicalizeRiskSubject(dimension, subject);
  if (!canonical) throw new Error("velocity_subject_invalid");
  // Version and dimension are inside the MAC input: the same address cannot be
  // correlated across dimensions by comparing identifiers, and a rotation
  // changes every identifier it produces.
  const message = new TextEncoder().encode(
    `${HASH_VERSION}:${dimension}:${canonical}`,
  );
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(), message);
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Domain-separated HMAC for short-lived private values that are not velocity
 * dimensions (for example a mailbox challenge code). Callers must still bind
 * all relevant context into `value`; this helper only guarantees that values
 * from different purposes cannot be correlated by comparing stored hashes.
 */
export async function hashPrivateValue(context: string, value: string): Promise<string> {
  if (!velocityHashingConfigured()) throw new Error("velocity_key_missing");
  const safeContext = String(context ?? "").trim();
  if (!/^[a-z0-9_-]{3,48}$/.test(safeContext)) throw new Error("private_hash_context_invalid");
  const rawValue = String(value ?? "");
  if (!rawValue || rawValue.length > 1024) throw new Error("private_hash_value_invalid");
  const message = new TextEncoder().encode(
    `${HASH_VERSION}:private:${safeContext}:${rawValue}`,
  );
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(), message);
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normaliseWindows(windowsSeconds: number[]): number[] {
  const seen = new Set<number>();
  for (const raw of windowsSeconds) {
    const seconds = Math.floor(Number(raw));
    // 7 digits mirrors the SQL guard; anything longer is a caller bug, not a
    // window anybody meant.
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= 9_999_999) {
      seen.add(seconds);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function createPostgresVelocityStore(db: SupabaseClient): RiskVelocityStore {
  return {
    async touch(queries: VelocityQuery[]): Promise<VelocityReading[]> {
      if (!queries.length) return [];
      if (queries.length > MAX_VELOCITY_ENTRIES) {
        throw new Error("velocity_too_many_entries");
      }

      const windowsByKey = new Map<string, number[]>();
      const entries = [];
      for (const query of queries) {
        const windows = normaliseWindows(query.windowsSeconds);
        const subjectHash = await hashSubject(query.dimension, query.subject);
        windowsByKey.set(`${query.dimension}:${subjectHash}`, windows);
        entries.push({
          dimension: query.dimension,
          subject_hash: subjectHash,
          hash_version: HASH_VERSION,
          windows_seconds: windows,
        });
      }

      const { data, error } = await db.rpc("abuse_velocity_touch", {
        p_entries: entries,
      });
      if (error) throw new Error(`velocity_rpc_failed:${error.code ?? "unknown"}`);

      const rows = Array.isArray(data) ? data : [];
      return rows.map((row: Record<string, unknown>) => {
        const dimension = String(row.dimension ?? "") as VelocityDimension;
        const rawCounts = (row.counts ?? {}) as Record<string, unknown>;
        const counts: Record<number, number> = {};
        // Report every window that was asked for. A window missing from the
        // reply reads as zero rather than as absent, so the engine never has to
        // distinguish "no hits" from "no answer" — it already knows an error
        // threw.
        for (const seconds of windowsByKey.get(`${dimension}:${String(row.subject_hash ?? "")}`) ?? []) {
          const value = Number(rawCounts[String(seconds)] ?? 0);
          counts[seconds] = Number.isFinite(value) && value > 0 ? value : 0;
        }
        return { dimension, counts };
      });
    },
  };
}
