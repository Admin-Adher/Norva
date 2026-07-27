// Durable Telegram notifier for new Supabase Auth users.
//
// PostgreSQL freezes the allow-listed signup snapshot and owns leases/retries.
// This cron-authenticated worker only renders the message, calls Telegram and
// CAS-acknowledges the result. It never receives passwords, tokens, phone
// numbers, raw metadata or arbitrary profile fields.

import { createClient } from "npm:@supabase/supabase-js@2";
import {
  sendTelegramDetailed,
  telegramConfigured,
  tgEscape,
} from "../_shared/telegram.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
const DELIVERY_BATCH = 10;
const DELIVERY_SPACING_MS = 100;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface SignupClaim {
  id: number;
  user_id: string;
  lease_token: string;
  user_email: string | null;
  display_name: string | null;
  auth_provider: string;
  email_confirmed: boolean;
  signed_up_at: string;
  attempt_count: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clipped(value: string | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function signupMessage(claim: SignupClaim): string {
  const email = clipped(claim.user_email, 320);
  const name = clipped(claim.display_name, 160);
  const provider = clipped(claim.auth_provider, 50) ?? "unknown";
  const signedUp = new Date(claim.signed_up_at);
  const timestamp = Number.isFinite(signedUp.getTime())
    ? signedUp.toISOString().replace("T", " ").replace(".000Z", " UTC")
    : "Unavailable";

  return [
    "👋 <b>Nouvelle inscription Norva</b>",
    `📧 <b>Email :</b> ${email ? tgEscape(email) : "Non renseigné"}`,
    `👤 <b>Nom :</b> ${name ? tgEscape(name) : "Non renseigné"}`,
    `🔐 <b>Méthode :</b> ${tgEscape(provider)}`,
    `✉️ <b>Email confirmé :</b> ${claim.email_confirmed ? "Oui" : "En attente"}`,
    `🆔 <b>Utilisateur :</b> <code>${tgEscape(claim.user_id.slice(0, 36))}</code>`,
    `🕒 <b>Inscription :</b> ${tgEscape(timestamp)}`,
  ].join("\n");
}

function retryableTelegramStatus(status: number | null): boolean {
  return status === null || status === 408 || status === 425 || status === 429 ||
    (status !== null && status >= 500);
}

async function health(): Promise<unknown> {
  const { data, error } = await admin.rpc("signup_telegram_delivery_health");
  return error ? null : data;
}

async function drain(): Promise<Record<string, unknown>> {
  if (!telegramConfigured()) {
    return {
      configured: false,
      claimed: 0,
      sent: 0,
      retry_scheduled: 0,
      dead_letter: 0,
      lease_lost: 0,
      accepted_unacknowledged: 0,
      health: await health(),
    };
  }

  const { data, error } = await admin.rpc("claim_signup_telegram_deliveries", {
    p_batch: DELIVERY_BATCH,
    p_lease_seconds: 90,
    p_max_attempts: 12,
  });
  if (error) throw new Error(`signup_telegram_claim_failed:${error.code ?? "db_error"}`);
  const claims = (Array.isArray(data) ? data : []) as SignupClaim[];
  const result = {
    configured: true,
    claimed: claims.length,
    sent: 0,
    retry_scheduled: 0,
    dead_letter: 0,
    lease_lost: 0,
    accepted_unacknowledged: 0,
  };

  for (let index = 0; index < claims.length; index++) {
    const claim = claims[index];
    const sent = await sendTelegramDetailed(signupMessage(claim));

    if (sent.accepted && sent.messageId !== null && sent.status !== null) {
      const { data: completed, error: completeError } = await admin.rpc(
        "complete_signup_telegram_delivery",
        {
          p_id: claim.id,
          p_lease_token: claim.lease_token,
          p_message_id: sent.messageId,
          p_http_status: sent.status,
        },
      );
      if (completeError || completed !== true) {
        // Telegram has no idempotency key. Keep the lease untouched so a rare
        // accepted-but-unacknowledged send stays observable before retry.
        result.accepted_unacknowledged++;
        console.error("[norva-signup-notify] Telegram accepted but DB acknowledgement failed");
      } else {
        result.sent++;
      }
    } else {
      const retryable = retryableTelegramStatus(sent.status);
      const { data: failure, error: failError } = await admin.rpc(
        "fail_signup_telegram_delivery",
        {
          p_id: claim.id,
          p_lease_token: claim.lease_token,
          p_http_status: sent.status,
          p_error: sent.error || "telegram_delivery_failed",
          p_retryable: retryable,
          p_retry_after_seconds: sent.retryAfterSeconds,
          p_max_attempts: 12,
        },
      );
      if (failError || failure === "lease_lost") result.lease_lost++;
      else if (failure === "retry_scheduled") result.retry_scheduled++;
      else if (failure === "dead_letter") result.dead_letter++;

      if (sent.status === 429 && index < claims.length - 1) {
        const retryAfter = sent.retryAfterSeconds ?? 60;
        for (const deferred of claims.slice(index + 1)) {
          await admin.rpc("defer_signup_telegram_delivery", {
            p_id: deferred.id,
            p_lease_token: deferred.lease_token,
            p_retry_after_seconds: retryAfter,
          });
        }
        break;
      }
    }

    if (index < claims.length - 1) await sleep(DELIVERY_SPACING_MS);
  }

  return { ...result, health: await health() };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);

  const path = new URL(req.url).pathname.replace(/^.*\/norva-signup-notify/, "") || "/";
  if (path !== "/cron/drain") return json({ error: "Not found" }, 404);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: authorized, error: authError } = await admin.rpc("norva_verify_cron_secret", {
    presented: token,
  });
  if (authError || authorized !== true) return json({ error: "Unauthorized" }, 403);

  try {
    return json({ ok: true, ...(await drain()) });
  } catch (error) {
    console.error(
      "[norva-signup-notify] drain failed",
      error instanceof Error ? error.message.slice(0, 160) : "unknown_error",
    );
    return json({ error: "Drain failed" }, 500);
  }
});
