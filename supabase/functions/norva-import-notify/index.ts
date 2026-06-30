// Phase 1 import-lifecycle DIGEST sender. A pg_cron job POSTs here every ~2 min; this reads the
// cloud_import_notifications queue (filled by the sync engine), GROUPS pending events by (user, kind)
// within a short settle window, sends ONE branded English email per group via Resend, and marks them
// sent. English-only (Norva is English-only). Auth mirrors the source-sync crons (norva_verify_cron_secret).
//
// Cron to register AT DEPLOY (held until then — pointing a cron at a missing function would 404 every run):
//   select cron.schedule('norva-import-notify-digest', '*/2 * * * *', $$
//     select net.http_post(
//       url := 'https://oupsceccxsonaalhueff.supabase.co/functions/v1/norva-import-notify/cron/digest',
//       headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
//         (select decrypted_secret from vault.decrypted_secrets where name = 'norva_cron_shared_secret')),
//       body := '{}'::jsonb, timeout_milliseconds := 60000);
//   $$);

import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { renderImportStarted, renderImportCompleted, renderImportFailed, type ProviderStat } from "../_shared/import-email.ts";
import { sendFcmPush, fcmConfigured } from "../_shared/fcm.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
const SETTLE_MS = 60_000;   // let a burst (multi-provider add) settle so it digests into one email
const BATCH = 500;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

interface Row { id: string; user_id: string; source_id: string; kind: string; payload: Record<string, unknown> | null }

function firstNameOf(user: { user_metadata?: Record<string, unknown>; email?: string } | null): string | null {
  const m = user?.user_metadata ?? {};
  const full = String(m.full_name ?? m.name ?? m.first_name ?? "").trim();
  if (full) return full.split(/\s+/)[0];
  return null;
}

async function providerStats(db: SupabaseClient, sourceIds: string[], withCounts: boolean): Promise<ProviderStat[]> {
  const out: ProviderStat[] = [];
  for (const sourceId of sourceIds) {
    const { data: src } = await db.from("cloud_sources").select("display_name").eq("id", sourceId).maybeSingle();
    const name = String((src as { display_name?: string } | null)?.display_name ?? "Your provider");
    const stat: ProviderStat = { name };
    if (withCounts) {
      for (const [key, type] of [["movies", "movie"], ["series", "series"]] as const) {
        const { count } = await db.from("cloud_media_items").select("id", { count: "exact", head: true })
          .eq("source_id", sourceId).eq("item_type", type);
        stat[key] = count ?? 0;
      }
      const { count: live } = await db.from("cloud_media_items").select("id", { count: "exact", head: true })
        .eq("source_id", sourceId).not("item_type", "in", "(movie,series)");
      stat.channels = live ?? 0;
    }
    out.push(stat);
  }
  return out;
}

function renderFor(kind: string, firstName: string | null, providers: ProviderStat[]): { subject: string; html: string } | null {
  if (kind === "import_started") return renderImportStarted(firstName, providers);
  if (kind === "import_completed") return renderImportCompleted(firstName, providers);
  if (kind === "import_failed") return renderImportFailed(firstName, providers);
  return null;
}

// Short push copy (mobile, app-closed). Completed/failed only — "started" stays email-only (the user
// just acted and is likely in the app).
function pushTextFor(kind: string, providers: ProviderStat[]): { title: string; body: string } {
  const many = providers.length > 1;
  if (kind === "import_completed") {
    const p0 = providers[0] ?? { name: "Your catalog" };
    const stats = many ? `${providers.length} catalogs ready` : [
      p0.movies ? `${p0.movies.toLocaleString("en-US")} movies` : "",
      p0.series ? `${p0.series.toLocaleString("en-US")} series` : "",
      p0.channels ? `${p0.channels.toLocaleString("en-US")} channels` : "",
    ].filter(Boolean).join(" · ");
    return { title: many ? "Your catalogs are ready 🎬" : `${p0.name} is ready 🎬`, body: stats || "Your catalog is ready to watch." };
  }
  return { title: "Import issue", body: `We hit a snag importing ${providers.map((p) => p.name).join(", ")}. We're on it.` };
}

// Send an FCM push to all of a user's registered devices (best-effort). Dead tokens (UNREGISTERED) are
// purged. Runs alongside the email so app-closed mobile users are notified too.
async function sendPushForGroup(db: SupabaseClient, userId: string, kind: string, providers: ProviderStat[]): Promise<void> {
  if (!fcmConfigured()) return;
  try {
    const { data: toks } = await db.from("cloud_push_tokens").select("token").eq("user_id", userId);
    const tokens = [...new Set((toks ?? []).map((t) => String((t as { token?: string }).token)).filter(Boolean))];
    if (!tokens.length) return;
    const { title, body } = pushTextFor(kind, providers);
    for (const token of tokens) {
      const r = await sendFcmPush(token, { title, body, data: { kind } });
      if (r.unregistered) { try { await db.from("cloud_push_tokens").delete().eq("token", token); } catch (_) { /* noop */ } }
    }
  } catch (_) { /* best-effort */ }
}

async function runDigest(db: SupabaseClient): Promise<Record<string, number>> {
  const cutoff = new Date(Date.now() - SETTLE_MS).toISOString();
  const { data, error } = await db.from("cloud_import_notifications")
    .select("id,user_id,source_id,kind,payload")
    .eq("status", "pending")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`queue read failed: ${error.message}`);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return { groups: 0, sent: 0, skipped: 0, rows: 0 };

  // Group by (user_id, kind).
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.user_id}|${r.kind}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  let sent = 0, skipped = 0;
  for (const [, grp] of groups) {
    const ids = grp.map((r) => r.id);
    const userId = grp[0].user_id, kind = grp[0].kind;
    try {
      const { data: u } = await db.auth.admin.getUserById(userId);
      const email = u?.user?.email ?? null;
      if (!email || !RESEND_API_KEY) {
        await db.from("cloud_import_notifications").update({ status: "skipped", sent_at: new Date().toISOString() }).in("id", ids);
        skipped += ids.length;
        continue;
      }
      const sourceIds = [...new Set(grp.map((r) => r.source_id))];
      const providers = await providerStats(db, sourceIds, kind === "import_completed");
      const rendered = renderFor(kind, firstNameOf(u?.user ?? null), providers);
      if (!rendered) { await db.from("cloud_import_notifications").update({ status: "skipped" }).in("id", ids); skipped += ids.length; continue; }

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [email], subject: rendered.subject, html: rendered.html }),
      });
      if (!res.ok) {
        console.error("[norva-import-notify] Resend failed", res.status, await res.text().catch(() => ""));
        continue; // leave pending → retried next run
      }
      await db.from("cloud_import_notifications").update({ status: "sent", sent_at: new Date().toISOString() }).in("id", ids);
      sent += ids.length;
      // Mobile push (app-closed) alongside the email, for the actionable kinds.
      if (kind === "import_completed" || kind === "import_failed") await sendPushForGroup(db, userId, kind, providers);
    } catch (e) {
      console.error("[norva-import-notify] group failed", userId, kind, e instanceof Error ? e.message : e);
      // leave pending → retried next run
    }
  }
  return { groups: groups.size, sent, skipped, rows: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Service not configured" }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Cron auth: same secret check as the source-sync crons.
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ok, error: authErr } = await db.rpc("norva_verify_cron_secret", { presented: token });
  if (authErr || ok !== true) return json({ error: "Unauthorized" }, 403);

  try {
    const result = await runDigest(db);
    return json({ ok: true, ...result });
  } catch (e) {
    console.error("[norva-import-notify] digest failed", e instanceof Error ? e.message : e);
    return json({ error: "digest failed" }, 500);
  }
});
