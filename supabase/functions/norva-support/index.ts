// norva-support — support tickets, both sides of the conversation.
//
// USER routes (Supabase JWT):
//   POST /create {subject, body}    → open a ticket + first message; email support@norva.tv
//   POST /reply  {ticket_id, body}  → reply on own ticket (reopens it); email support@norva.tv
//   POST /close  {ticket_id}        → mark own ticket resolved (frees the open-tickets cap)
//   GET  /mine                      → own tickets with full threads (powers support.html)
// ADMIN routes (JWT with app_metadata.role='admin'):
//   POST /admin/reply  {ticket_id, body}   → reply; ticket → 'pending'; EMAILS THE CLIENT
//   POST /admin/status {ticket_id, status} → open | pending | closed
//
// Tables are RLS-on with no policies: this function (service role) and the admin RPCs are the only
// doors. Notification emails are best-effort — the ticket is stored first, mail failures never 500.
// The support@ notification sets reply_to to the client so a quick answer from the mailbox is
// possible, but tracked replies happen through the CRM (they land in the thread + email the client).

import { createClient } from "npm:@supabase/supabase-js@2";
import { sendTelegram, tgEscape } from "../_shared/telegram.ts";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("AUTH_EMAIL_FROM") ?? "Norva <noreply@norva.tv>";
const SUPPORT_INBOX = "support@norva.tv";
const SITE_URL = "https://norva.tv";

// Anti-abuse: every user message emails support@ (Resend cost + inbox flood). Cap concurrent open
// tickets and hourly message volume per user, and drop identical consecutive bodies.
const MAX_OPEN_TICKETS = 8;
const MAX_MSGS_PER_HOUR = 20;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Minimal branded shell (same look as the lifecycle emails).
function shell(heading: string, bodyHtml: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<tr><td align="center" style="padding:8px 0 26px"><a href="${cta.url}" style="display:inline-block;background:#5b7cfa;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">${esc(cta.label)}</a></td></tr>`
    : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0a0c11">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
      <tr><td style="padding:28px 32px 6px;text-align:center">
        <div style="color:#ffffff;font-family:Arial,sans-serif;font-size:20px;font-weight:700">Norva</div></td></tr>
      <tr><td style="padding:14px 32px 6px"><h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:18px;font-weight:800">${esc(heading)}</h1></td></tr>
      <tr><td style="padding:12px 32px 18px;color:#9aa6bd;font-family:Arial,sans-serif;font-size:14px;line-height:1.65">${bodyHtml}</td></tr>
      ${button}
    </table>
  </td></tr></table></body></html>`;
}

async function sendMail(to: string[], subject: string, html: string, replyTo?: string): Promise<void> {
  if (!RESEND_API_KEY || !to.length) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
  } catch (_) { /* best-effort */ }
}

// Notify the support inbox about a new user message (creation or reply).
// Email (Resend) + Telegram, both best-effort AFTER the ticket/message is stored —
// notification loss must never lose the ticket itself.
async function notifySupport(kind: "new" | "reply", ticketId: string, userEmail: string, subject: string, body: string): Promise<void> {
  const heading = kind === "new" ? "Nouveau ticket support" : "Réponse client sur un ticket";
  const html = shell(heading,
    `<b style="color:#cdd6e6">${esc(userEmail)}</b> — « ${esc(subject)} »<br><br>
     <div style="background:#0d1117;border:1px solid #1f2733;border-radius:10px;padding:12px 14px;color:#e8e8ee;white-space:pre-wrap">${esc(body).slice(0, 4000)}</div><br>
     Répondre depuis le CRM (fiche client + page Support) pour garder le fil tracé.`,
    { label: "Ouvrir le CRM", url: `${SITE_URL}/app#admin` });
  await sendMail([SUPPORT_INBOX], `[Support] ${subject}`, html, userEmail);
  await sendTelegram(
    `${kind === "new" ? "🎫 <b>Nouveau ticket support</b>" : "💬 <b>Réponse client — ticket</b>"}\n` +
    `<b>${tgEscape(userEmail)}</b> — « ${tgEscape(subject.slice(0, 180))} »\n` +
    `${tgEscape(body.slice(0, 500))}${body.length > 500 ? "…" : ""}`,
  );
}

async function getUser(req: Request) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data?.user ?? null;
}

// Count a user's own (non-admin) messages in the last hour — author_email is set server-side.
async function userMsgCountLastHour(email: string): Promise<number> {
  if (!email) return 0;
  const since = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db.from("cloud_support_messages")
    .select("ticket_id", { count: "exact", head: true })
    .eq("from_admin", false).eq("author_email", email).gte("created_at", since);
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "not configured" }, 500);
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/norva-support/, "") || "/";

  const user = await getUser(req);
  if (!user?.id) return json({ error: "Not signed in" }, 401);
  const isAdmin = (user.app_metadata as JsonRecord | undefined)?.role === "admin";

  // ── USER: create a ticket ──────────────────────────────────────────────────
  if (req.method === "POST" && path === "/create") {
    let payload: { subject?: string; body?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const subject = String(payload.subject ?? "").trim().slice(0, 180);
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (subject.length < 3 || body.length < 5) return json({ error: "Please describe your issue (subject and message)." }, 400);

    // Rate limit: too many concurrent tickets, or too many messages in the last hour.
    const { count: openCount } = await db.from("cloud_support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id).in("status", ["open", "pending"]);
    if ((openCount ?? 0) >= MAX_OPEN_TICKETS)
      return json({ error: "You already have several open tickets — please continue in an existing one." }, 429);
    if (await userMsgCountLastHour(user.email ?? "") >= MAX_MSGS_PER_HOUR)
      return json({ error: "Too many messages in a short time. Please wait a little and try again." }, 429);

    // Dedupe double-submit: an identical subject from the same user within 10 min returns the
    // existing ticket instead of opening a duplicate (each dup emails support + eats the cap).
    const since10 = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: dup } = await db.from("cloud_support_tickets")
      .select("id").eq("user_id", user.id).eq("subject", subject).gte("created_at", since10)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (dup) return json({ ok: true, ticket_id: dup.id, deduped: true });

    const { data: t, error } = await db.from("cloud_support_tickets")
      .insert({ user_id: user.id, subject }).select("id").single();
    if (error || !t) return json({ error: "Could not open the ticket" }, 500);
    await db.from("cloud_support_messages").insert({ ticket_id: t.id, from_admin: false, author_email: user.email, body });
    await notifySupport("new", String(t.id), user.email ?? "", subject, body);
    return json({ ok: true, ticket_id: t.id });
  }

  // ── USER: reply on own ticket ──────────────────────────────────────────────
  if (req.method === "POST" && path === "/reply") {
    let payload: { ticket_id?: string; body?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (!ticketId || body.length < 2) return json({ error: "Empty message" }, 400);

    const { data: t } = await db.from("cloud_support_tickets")
      .select("id,user_id,subject").eq("id", ticketId).maybeSingle();
    if (!t || String(t.user_id) !== user.id) return json({ error: "Ticket not found" }, 404);

    if (await userMsgCountLastHour(user.email ?? "") >= MAX_MSGS_PER_HOUR)
      return json({ error: "Too many messages in a short time. Please wait a little and try again." }, 429);

    // Dedupe: an identical consecutive user body (double-submit / retry) is a no-op — no re-email.
    const { data: lastMsg } = await db.from("cloud_support_messages")
      .select("body,from_admin").eq("ticket_id", t.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (lastMsg && lastMsg.from_admin === false && String(lastMsg.body) === body) return json({ ok: true, deduped: true });

    await db.from("cloud_support_messages").insert({ ticket_id: t.id, from_admin: false, author_email: user.email, body });
    await db.from("cloud_support_tickets").update({
      status: "open", last_from: "user", last_message_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", t.id);
    await notifySupport("reply", String(t.id), user.email ?? "", String(t.subject), body);
    return json({ ok: true });
  }

  // ── USER: mark own ticket resolved ─────────────────────────────────────────
  // A user who's done cannot otherwise tidy up: only admins changed status, and every open
  // ticket counts toward MAX_OPEN_TICKETS. Idempotent on an already-closed ticket.
  if (req.method === "POST" && path === "/close") {
    let payload: { ticket_id?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    if (!ticketId) return json({ error: "Bad request" }, 400);
    const { data: t } = await db.from("cloud_support_tickets")
      .select("id,user_id,status").eq("id", ticketId).maybeSingle();
    if (!t || String(t.user_id) !== user.id) return json({ error: "Ticket not found" }, 404);
    if (t.status === "closed") return json({ ok: true, status: "closed" });
    await db.from("cloud_support_tickets").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", t.id);
    try {
      await db.from("admin_events").insert({ user_id: user.id, kind: "admin_action", summary: "Ticket support fermé par le client", actor: user.email });
    } catch (_) { /* best-effort */ }
    return json({ ok: true, status: "closed" });
  }

  // ── USER: my tickets with threads ──────────────────────────────────────────
  // ?tickets=only returns just the ticket rows (no thread bodies) — the in-app
  // "support replied" notification polls this cheaply from every app boot.
  if (req.method === "GET" && path === "/mine") {
    const { data: tickets } = await db.from("cloud_support_tickets")
      .select("id,subject,status,last_from,last_message_at,created_at")
      .eq("user_id", user.id).order("last_message_at", { ascending: false }).limit(50);
    if (url.searchParams.get("tickets") === "only") return json({ ok: true, tickets: tickets ?? [] });
    const ids = (tickets ?? []).map((t) => t.id);
    let messages: JsonRecord[] = [];
    if (ids.length) {
      const { data: msgs } = await db.from("cloud_support_messages")
        .select("ticket_id,from_admin,body,created_at").in("ticket_id", ids).order("created_at");
      messages = (msgs ?? []) as JsonRecord[];
    }
    return json({ ok: true, tickets: tickets ?? [], messages });
  }

  // ── ADMIN routes ───────────────────────────────────────────────────────────
  if (!isAdmin && path.startsWith("/admin/")) return json({ error: "not authorized" }, 403);

  if (req.method === "POST" && path === "/admin/reply") {
    let payload: { ticket_id?: string; body?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    const body = String(payload.body ?? "").trim().slice(0, 8000);
    if (!ticketId || body.length < 2) return json({ error: "Empty message" }, 400);

    const { data: t } = await db.from("cloud_support_tickets")
      .select("id,user_id,subject").eq("id", ticketId).maybeSingle();
    if (!t) return json({ error: "Ticket not found" }, 404);

    await db.from("cloud_support_messages").insert({ ticket_id: t.id, from_admin: true, author_email: user.email, body });
    await db.from("cloud_support_tickets").update({
      status: "pending", last_from: "admin", last_message_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", t.id);
    try {
      await db.from("admin_events").insert({ user_id: t.user_id, kind: "admin_action", summary: "Réponse support envoyée", actor: user.email });
    } catch (_) { /* best-effort */ }

    // Email the client (English — viewer-facing).
    const { data: target } = await db.auth.admin.getUserById(String(t.user_id));
    const clientEmail = target?.user?.email;
    if (clientEmail) {
      const html = shell("We replied to your support request",
        `Your ticket « <b style="color:#cdd6e6">${esc(t.subject)}</b> » has a new reply:<br><br>
         <div style="background:#0d1117;border:1px solid #1f2733;border-radius:10px;padding:12px 14px;color:#e8e8ee;white-space:pre-wrap">${esc(body).slice(0, 4000)}</div><br>
         You can reply from your support page — we'll get it right away.`,
        // Deep-link straight to THIS ticket (support.html auto-expands + scrolls ?ticket=).
        { label: "Open my support page", url: `${SITE_URL}/support.html?ticket=${encodeURIComponent(String(t.id))}` });
      await sendMail([clientEmail], `Re: ${t.subject} — Norva support`, html);
    }
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/admin/status") {
    let payload: { ticket_id?: string; status?: string } = {};
    try { payload = await req.json(); } catch (_) { /* validated below */ }
    const ticketId = String(payload.ticket_id ?? "");
    const status = String(payload.status ?? "");
    if (!ticketId || !["open", "pending", "closed"].includes(status)) return json({ error: "Bad request" }, 400);
    const { data: t } = await db.from("cloud_support_tickets").update({ status, updated_at: new Date().toISOString() })
      .eq("id", ticketId).select("user_id").maybeSingle();
    if (!t) return json({ error: "Ticket not found" }, 404);
    try {
      await db.from("admin_events").insert({ user_id: t.user_id, kind: "admin_action", summary: `Ticket support → ${status}`, actor: user.email });
    } catch (_) { /* best-effort */ }
    return json({ ok: true, status });
  }

  return json({ error: "Not found" }, 404);
});
