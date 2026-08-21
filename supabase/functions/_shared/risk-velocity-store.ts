// Velocity store for the anti-abuse engine — the only thing in the stack that
// knows how often a subject has been seen.
//
// It counts and returns counts. It has no thresholds, no verdicts and no opinion
// about what "too many" means: that belongs to the risk engine and to its
// configuration, so an attack is answered by changing a number rather than by
// deploying code.
//
// PSEUDONYMISATION. Callers pass raw subjects — an IP, an email, a device id —
// and this module is the single place that hashes them. Nothing raw reaches the
// database. The hash is SALTED from the environment, because a bare sha256 of an
// IPv4 address is not pseudonymisation: 2^32 candidates fall to a GPU in
// seconds, and an email in any breach corpus falls faster. With the salt held
// only in NORVA_ABUSE_HASH_SALT, a copy of the table identifies no one. Losing
// the salt makes the history unreadable, which is the intended trade.
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

// Adding a dimension means teaching the engine to compute it, so the list is
// code and mirrors the check constraint in the migration.
export type VelocityDimension =
  | "ip"
  | "ip_subnet_24"
  | "ip_subnet_48"
  | "asn"
  | "email"
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

const HASH_SALT = Deno.env.get("NORVA_ABUSE_HASH_SALT") ?? "";

export function velocityHashingConfigured(): boolean {
  // A short salt is worse than an obvious absence, because it looks configured.
  return HASH_SALT.length >= 32;
}

/**
 * Salted, normalised subject hash. Normalisation matters as much as the salt:
 * "User@Example.COM " and "user@example.com" are one person, and counting them
 * as two is how an email-rotation limit gets bypassed for free.
 */
export async function hashSubject(
  dimension: VelocityDimension,
  subject: string,
): Promise<string> {
  if (!velocityHashingConfigured()) {
    throw new Error("velocity_salt_missing");
  }
  const normalised = dimension === "email"
    ? subject.trim().toLowerCase()
    : subject.trim();
  if (!normalised) throw new Error("velocity_subject_empty");
  // The dimension is part of the input so the same address cannot be correlated
  // across dimensions by comparing hashes.
  const bytes = new TextEncoder().encode(`${HASH_SALT}:${dimension}:${normalised}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
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
