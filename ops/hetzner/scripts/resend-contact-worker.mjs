#!/usr/bin/env node

// Private Resend Contacts/Segments worker.
//
// This process deliberately exposes no HTTP listener.  It is the only runtime
// that receives RESEND_MANAGEMENT_API_KEY and talks to PostgREST over Docker's
// internal network using the service role.  Ambiguous claims/acks are never
// retried inline: database leases and revision CAS recover them safely.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { syncResendContactProjection } from "../../../supabase/functions/_shared/resend-audience.mjs";

const DEFAULT_HEALTH_FILE = "/tmp/resend-contact-worker-health.json";
const EXPECTED_SEGMENTS = Object.freeze([
  "internal-pilots",
  "onboarding",
  "trialing",
  "active-subscribers",
  "cancel-scheduled",
  "payment-recovery",
  "churned",
  "blocked-suppressed",
  "catalog-ready",
]);
const TOPIC_SLUG = "product-news-offers";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? ""));
const asInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

export function sanitizeDiagnostic(value, maxLength = 1000) {
  return String(value ?? "unknown error")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(/\b[0-9a-f]{32,128}\b/gi, "[redacted-token]")
    .replace(/\b(?:re|Bearer)_[A-Za-z0-9_-]{12,}\b/g, "[redacted-secret]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]{12,}/gi, "Bearer [redacted-secret]")
    .slice(0, maxLength);
}

export function isRetryableResendFailure(httpStatus, explicitRetryable) {
  if (typeof explicitRetryable === "boolean") return explicitRetryable;
  return httpStatus == null || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
}

function safeRemoteResult(result) {
  const steps = Array.isArray(result?.steps)
    ? result.steps.slice(0, 100).map((step) => ({
      operation: String(step?.operation ?? "unknown").slice(0, 50),
      status: Number.isInteger(step?.status) ? step.status : null,
      ...(Number.isInteger(step?.page) ? { page: step.page } : {}),
    }))
    : [];
  return {
    operation: String(result?.operation ?? "reconcile").slice(0, 50),
    steps,
  };
}

export class PostgrestClient {
  constructor({ baseUrl, serviceRoleKey, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    if (!baseUrl || !serviceRoleKey || typeof fetchImpl !== "function") {
      throw new Error("PostgREST client is not configured");
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.serviceRoleKey = serviceRoleKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const signal = typeof AbortSignal?.timeout === "function"
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const raw = (await response.text().catch(() => "")).slice(0, 16_384);
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); } catch { payload = raw; }
    }
    if (!response.ok) {
      const message = typeof payload?.message === "string"
        ? payload.message
        : `PostgREST HTTP ${response.status}`;
      const error = new Error(sanitizeDiagnostic(message));
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  rpc(name, args = {}) {
    // No automatic retry.  In particular, repeating an ambiguously successful
    // claim could hide the leased rows until expiry.
    return this.request("POST", `/rpc/${encodeURIComponent(name)}`, args);
  }

  listTaxonomy() {
    return this.request(
      "GET",
      "/cloud_resend_taxonomy?select=kind,slug,remote_id,managed,active&managed=eq.true&order=kind.asc,slug.asc",
    );
  }
}

function taxonomyIndex(rows) {
  if (!Array.isArray(rows)) throw new Error("Invalid Resend taxonomy response");
  const activeSegments = new Map();
  const managedSegmentIds = [];
  let topicId = null;
  for (const row of rows) {
    const id = String(row?.remote_id ?? "");
    const slug = String(row?.slug ?? "");
    if (row?.kind === "segment" && id) {
      managedSegmentIds.push(id);
      if (row?.active) activeSegments.set(slug, id);
    }
    if (row?.kind === "topic" && row?.active && slug === TOPIC_SLUG && id) topicId = id;
  }
  const missing = EXPECTED_SEGMENTS.filter((slug) => !activeSegments.has(slug));
  if (missing.length || !topicId) {
    throw new Error(`Resend taxonomy incomplete (${missing.length} segments, topic=${Boolean(topicId)})`);
  }
  return { activeSegments, managedSegmentIds: [...new Set(managedSegmentIds)], topicId };
}

function desiredSegmentIds(slugs, taxonomy) {
  if (!Array.isArray(slugs)) throw new Error("Invalid desired segment projection");
  return [...new Set(slugs.map((slug) => {
    const id = taxonomy.activeSegments.get(String(slug));
    if (!id) throw new Error("Unknown desired Resend segment");
    return id;
  }))];
}

async function bestEffortHeartbeat(db, status, summary, error, startedAt) {
  try {
    await db.rpc("record_resend_contact_worker_heartbeat", {
      p_status: status,
      p_summary: summary,
      p_error: error ? sanitizeDiagnostic(error) : null,
      p_started_at: startedAt,
    });
  } catch (heartbeatError) {
    return sanitizeDiagnostic(heartbeatError);
  }
  return null;
}

export async function runCycle({
  db,
  managementApiKey,
  fetchImpl = globalThis.fetch,
  batchSize = 12,
  reconcileBatchSize = 25,
  leaseSeconds = 180,
  perContactDelayMs = 300,
  resendMinIntervalMs = 300,
  projectionEnabled = true,
  dedicatedTeamConfirmed = true,
  now = () => new Date(),
}) {
  const startedAt = now().toISOString();
  const summary = {
    reconciled: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    permanent_failed: 0,
    cas_misses: 0,
    heartbeat_error: false,
  };

  if (!projectionEnabled || !dedicatedTeamConfirmed) {
    await bestEffortHeartbeat(db, "disabled", summary, null, startedAt);
    return { status: "disabled", started_at: startedAt, ...summary };
  }
  if (!/^re_[A-Za-z0-9_-]+$/.test(String(managementApiKey ?? ""))) {
    const error = "Resend management key is missing or invalid";
    await bestEffortHeartbeat(db, "error", summary, error, startedAt);
    return { status: "error", started_at: startedAt, error, ...summary };
  }

  try {
    // Refresh a small stale cohort before claiming.  This guarantees that
    // entitlement/locale/engagement changes are reflected even if no trigger
    // fired, without flooding the remote API with a daily full rebuild.
    const reconciled = await db.rpc("norva_reconcile_resend_contacts", {
      p_limit: reconcileBatchSize,
      p_stale_after: "24 hours",
    });
    summary.reconciled = Number(reconciled ?? 0) || 0;

    const taxonomy = taxonomyIndex(await db.listTaxonomy());
    const claims = await db.rpc("claim_resend_audience_outbox", {
      p_limit: batchSize,
      p_lease_seconds: leaseSeconds,
    });
    if (!Array.isArray(claims)) throw new Error("Invalid Resend outbox claim response");
    summary.claimed = claims.length;

    for (let index = 0; index < claims.length; index += 1) {
      const claim = claims[index];
      let result;
      try {
        result = await syncResendContactProjection({
          apiKey: managementApiKey,
          email: claim.email,
          unsubscribed: Boolean(claim.desired_unsubscribed),
          firstName: claim.first_name ?? null,
          properties: claim.contact_properties ?? {},
          desiredSegmentIds: desiredSegmentIds(claim.desired_segment_slugs ?? [], taxonomy),
          managedSegmentIds: taxonomy.managedSegmentIds,
          topicId: taxonomy.topicId,
          topicSubscription: claim.desired_topic_subscription === "opt_in" ? "opt_in" : "opt_out",
          fetchImpl,
          minIntervalMs: resendMinIntervalMs,
        });
      } catch (error) {
        // Projection/taxonomy exceptions are local schema/config failures, not
        // transient network failures. A new desired-state revision explicitly
        // re-opens a terminal row after operators fix the cause.
        result = { ok: false, retryable: false, httpStatus: null, result: null, error: sanitizeDiagnostic(error) };
      }

      const rpcName = result.ok
        ? "complete_resend_audience_outbox"
        : "fail_resend_audience_outbox";
      const payload = result.ok ? {
        p_email: claim.email,
        p_revision: claim.revision,
        p_lease_token: claim.lease_token,
        p_http_status: Number(result.httpStatus) || 200,
        p_result: safeRemoteResult(result.result),
      } : {
        p_email: claim.email,
        p_revision: claim.revision,
        p_lease_token: claim.lease_token,
        p_http_status: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
        p_result: safeRemoteResult(result.result),
        p_error: sanitizeDiagnostic(result.error),
        p_retryable: isRetryableResendFailure(result.httpStatus, result.retryable),
      };

      try {
        const acknowledged = await db.rpc(rpcName, payload);
        if (acknowledged === true) {
          if (result.ok) summary.completed += 1;
          else {
            summary.failed += 1;
            if (!payload.p_retryable) summary.permanent_failed += 1;
          }
        } else {
          // A newer revision may already exist.  Do not overwrite/retry it;
          // lease expiry plus the revision CAS is the recovery mechanism.
          summary.cas_misses += 1;
        }
      } catch {
        // The Resend request may have succeeded while the database ack was
        // ambiguous.  Never issue a second remote request inside this cycle.
        summary.cas_misses += 1;
      }

      if (index + 1 < claims.length && perContactDelayMs > 0) await wait(perContactDelayMs);
    }

    const projectionHealth = await db.rpc("resend_contact_projection_health", {});
    summary.backlog = Number(projectionHealth?.backlog ?? 0) || 0;
    summary.opt_out_backlog = Number(projectionHealth?.opt_out_backlog ?? 0) || 0;
    summary.permanent_failure_count = Number(projectionHealth?.permanent_failure_count ?? 0) || 0;
    const status = summary.failed > 0 || summary.cas_misses > 0 ? "degraded" : "ok";
    const heartbeatError = await bestEffortHeartbeat(db, status, summary, null, startedAt);
    summary.heartbeat_error = Boolean(heartbeatError);
    return { status: heartbeatError ? "degraded" : status, started_at: startedAt, ...summary };
  } catch (error) {
    const message = sanitizeDiagnostic(error);
    const heartbeatError = await bestEffortHeartbeat(db, "error", summary, message, startedAt);
    summary.heartbeat_error = Boolean(heartbeatError);
    return { status: "error", started_at: startedAt, error: message, ...summary };
  }
}

async function writeHealthFile(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  const payload = JSON.stringify({ ...state, written_at: new Date().toISOString() });
  await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, path);
}

export async function checkHealthFile(path = DEFAULT_HEALTH_FILE, maxAgeSeconds = 180) {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    const writtenAt = Date.parse(parsed.written_at ?? "");
    const fresh = Number.isFinite(writtenAt) && Date.now() - writtenAt <= maxAgeSeconds * 1000;
    const healthyStatus = ["ok", "degraded", "disabled"].includes(parsed.status);
    return { ok: fresh && healthyStatus, fresh, state: parsed };
  } catch (error) {
    return { ok: false, fresh: false, error: sanitizeDiagnostic(error) };
  }
}

function configFromEnv(env = process.env) {
  return {
    baseUrl: env.POSTGREST_URL || "http://rest:3000",
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    managementApiKey: env.RESEND_MANAGEMENT_API_KEY || "",
    projectionEnabled: truthy(env.RESEND_CONTACT_PROJECTION_ENABLED),
    dedicatedTeamConfirmed: truthy(env.RESEND_DEDICATED_TEAM_CONFIRMED),
    batchSize: asInteger(env.RESEND_CONTACT_BATCH_SIZE, 12, 1, 25),
    reconcileBatchSize: asInteger(env.RESEND_CONTACT_RECONCILE_BATCH_SIZE, 25, 1, 100),
    leaseSeconds: asInteger(env.RESEND_CONTACT_LEASE_SECONDS, 180, 60, 900),
    perContactDelayMs: asInteger(env.RESEND_CONTACT_PACING_MS, 300, 275, 5_000),
    resendMinIntervalMs: asInteger(env.RESEND_CONTACT_API_INTERVAL_MS, 300, 200, 5_000),
    pollIntervalMs: asInteger(env.RESEND_CONTACT_POLL_SECONDS, 60, 15, 900) * 1000,
    healthFile: env.RESEND_CONTACT_HEALTH_FILE || DEFAULT_HEALTH_FILE,
    healthMaxAgeSeconds: asInteger(env.RESEND_CONTACT_HEALTH_MAX_AGE_SECONDS, 180, 30, 1800),
  };
}

async function main() {
  const config = configFromEnv();
  if (process.argv.includes("--health")) {
    const health = await checkHealthFile(config.healthFile, config.healthMaxAgeSeconds);
    if (!health.ok) process.stderr.write(`${JSON.stringify(health)}\n`);
    process.exitCode = health.ok ? 0 : 1;
    return;
  }

  if (!config.serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  const db = new PostgrestClient({ baseUrl: config.baseUrl, serviceRoleKey: config.serviceRoleKey });
  const runOnce = async () => {
    const result = await runCycle({ db, ...config });
    await writeHealthFile(config.healthFile, result);
    process.stdout.write(`${JSON.stringify({
      event: "resend_contact_cycle",
      status: result.status,
      reconciled: result.reconciled,
      claimed: result.claimed,
      completed: result.completed,
      failed: result.failed,
      permanent_failed: result.permanent_failed,
      permanent_failure_count: result.permanent_failure_count,
      cas_misses: result.cas_misses,
      backlog: result.backlog ?? null,
    })}\n`);
    return result;
  };

  if (process.argv.includes("--once")) {
    const result = await runOnce();
    process.exitCode = result.status === "error" ? 1 : 0;
    return;
  }

  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  while (!stopping) {
    await runOnce().catch(async (error) => {
      const state = { status: "error", error: sanitizeDiagnostic(error) };
      await writeHealthFile(config.healthFile, state).catch(() => {});
      process.stderr.write(`${JSON.stringify({ event: "resend_contact_cycle", ...state })}\n`);
    });
    if (!stopping) await wait(config.pollIntervalMs);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "resend_contact_worker_fatal", error: sanitizeDiagnostic(error) })}\n`);
    process.exitCode = 1;
  });
}
