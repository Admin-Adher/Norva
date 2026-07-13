// Lifecycle / billing email templates (English-only — Norva is English-only). Pure render
// functions, no side effects: the norva-lifecycle cron builds the recipient + context and calls
// these, then sends via Resend. Branding mirrors import-email.ts / norva-auth-email (dark theme,
// table + inline styles, email-client-safe).
//
// Covers: welcome (on signup), trial-ending reminder (J-2, before auto-charge), payment receipt,
// failed-payment dunning (escalating), and win-back. The trial/dunning/win-back copy assumes a
// CARD-backed trial that auto-converts — the cron only sends those when the billing rail is live
// (NORVA_LIFECYCLE_BILLING_LIVE=true), so the "we'll charge you" promise is always truthful.

const SITE_URL = "https://norva.tv";
const OPEN_URL = `${SITE_URL}/app.html`;
const SUBSCRIBE_URL = `${SITE_URL}/subscribe.html`;
const MANAGE_URL = `${SITE_URL}/subscription.html`;
const SUPPORT_URL = "mailto:support@norva.tv";
const UNSUBSCRIBE_URL = "mailto:unsubscribe@norva.tv?subject=unsubscribe";
// CAN-SPAM requires a physical postal address in commercial mail. Set the env var to
// your registered business address; the footer shows it only when present (never a
// fabricated one). Required before the marketing flows (win-back / abandoned) send.
const POSTAL_ADDRESS = (() => {
  try { return Deno.env.get("NORVA_POSTAL_ADDRESS") ?? ""; } catch (_) { return ""; }
})();

export interface Rendered { subject: string; html: string }

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function greet(firstName?: string | null): string {
  const n = (firstName ?? "").trim();
  return n ? `Hi ${esc(n)},` : "Hi,";
}

// Generic branded shell: heading + HTML body (already-escaped/safe) + optional CTA + footer note.
function shell(opts: { heading: string; bodyHtml: string; cta?: { label: string; url: string }; note?: string }): string {
  const button = opts.cta
    ? `<tr><td align="center" style="padding:8px 0 26px">
         <a href="${opts.cta.url}" style="display:inline-block;background:#5b7cfa;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 30px;border-radius:10px">${esc(opts.cta.label)}</a>
       </td></tr>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0c11">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c11">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#11151d;border:1px solid #1f2733;border-radius:16px;overflow:hidden">
        <tr><td style="padding:32px 32px 8px;text-align:center">
          <img src="${SITE_URL}/img/norva-app-icon.png" width="48" height="48" alt="Norva" style="border-radius:12px">
          <div style="color:#ffffff;font-family:'Century Gothic',Arial,sans-serif;font-size:22px;font-weight:600;letter-spacing:-.02em;margin-top:10px">Norva</div>
        </td></tr>
        <tr><td style="padding:18px 32px 6px;text-align:center">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,sans-serif;font-size:21px;font-weight:800">${esc(opts.heading)}</h1>
        </td></tr>
        <tr><td style="padding:12px 32px 18px;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.65">${opts.bodyHtml}</td></tr>
        ${button}
        <tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          ${opts.note ?? `Questions? <a href="${SUPPORT_URL}" style="color:#7f8db0">support@norva.tv</a>. Norva is a media player and includes no content.`}
        </td></tr>
      </table>
      <div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px;line-height:1.7">
        <a href="${UNSUBSCRIBE_URL}" style="color:#4a5470">Unsubscribe</a>${POSTAL_ADDRESS ? ` &middot; ${esc(POSTAL_ADDRESS)}` : ""}<br>© Norva
      </div>
    </td></tr>
  </table>
</body></html>`;
}

// Format a date like "12 July 2026" (UTC) for the reader.
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  } catch (_) { return ""; }
}

export function renderWelcome(firstName: string | null): Rendered {
  return {
    subject: "Welcome to Norva — let's connect your first source",
    html: shell({
      heading: "Welcome to Norva 👋",
      bodyHtml: `${greet(firstName)}<br><br>
        Your Norva account is ready. Norva is your <b style="color:#cdd6e6">multi-screen media player</b> — it brings no content of its own; you connect a compatible source you're authorized to use, and Norva organizes it and keeps every screen in sync.<br><br>
        <b style="color:#cdd6e6">One step to start watching:</b> open Norva and paste the link from the TV service you already use. Norva reads it and builds your catalog automatically — no card needed to connect.`,
      cta: { label: "Connect my source", url: OPEN_URL },
      note: "You can watch on Web, Android phone, tablet and Android TV with the same account.",
    }),
  };
}

export function renderTrialEnding(firstName: string | null, opts: { endsAt: string; planLabel?: string }): Rendered {
  const when = fmtDate(opts.endsAt);
  const plan = opts.planLabel ? esc(opts.planLabel) : "your Norva plan";
  return {
    subject: "Your Norva free trial ends in 2 days",
    html: shell({
      heading: "Your trial ends in 2 days",
      bodyHtml: `${greet(firstName)}<br><br>
        Just a heads-up: your <b style="color:#cdd6e6">7-day free trial</b> ends${when ? ` on <b style="color:#cdd6e6">${when}</b>` : " soon"}, and ${plan} will then renew automatically so your access continues without interruption.<br><br>
        Nothing to do if you'd like to keep watching. If Norva isn't for you, you can <b style="color:#cdd6e6">cancel anytime</b> before the trial ends and you won't be charged.`,
      cta: { label: "Manage my plan", url: MANAGE_URL },
      note: `Cancel anytime from your account. Questions? <a href="${SUPPORT_URL}" style="color:#7f8db0">support@norva.tv</a>.`,
    }),
  };
}

export function renderReceipt(firstName: string | null, opts: { planLabel?: string; amount?: string; periodEnd?: string }): Rendered {
  const plan = opts.planLabel ? esc(opts.planLabel) : "Norva";
  const amount = opts.amount ? esc(opts.amount) : "";
  const renews = fmtDate(opts.periodEnd);
  return {
    subject: "Your Norva subscription is active — receipt",
    html: shell({
      heading: "You're all set ✨",
      bodyHtml: `${greet(firstName)}<br><br>
        Thanks for subscribing to <b style="color:#cdd6e6">${plan}</b>${amount ? ` (${amount})` : ""}. Your subscription is active on all your screens.${renews ? `<br><br>Your plan renews on <b style="color:#cdd6e6">${renews}</b>. You can manage or cancel it anytime.` : ""}`,
      cta: { label: "Open Norva", url: OPEN_URL },
      note: `Manage your plan at <a href="${MANAGE_URL}" style="color:#7f8db0">norva.tv/subscription</a>.`,
    }),
  };
}

export function renderPaymentFailed(firstName: string | null, stage: number): Rendered {
  // stage 1 = gentle, 2 = firmer, 3 = final notice before access pauses.
  const final = stage >= 3;
  return {
    subject: final ? "Action needed: your Norva access is about to pause" : "We couldn't process your Norva payment",
    html: shell({
      heading: final ? "Last reminder" : "Payment issue",
      bodyHtml: `${greet(firstName)}<br><br>
        We tried to renew your Norva subscription but the payment didn't go through${stage > 1 ? " on our latest attempt" : ""}. This usually means an expired card or insufficient funds.<br><br>
        ${final
          ? "To avoid losing access, please update your payment method now."
          : "Please update your payment method and we'll retry automatically. Your access continues in the meantime."}`,
      cta: { label: "Update payment method", url: MANAGE_URL },
      note: `Already fixed it? You can ignore this email. Questions? <a href="${SUPPORT_URL}" style="color:#7f8db0">support@norva.tv</a>.`,
    }),
  };
}

export function renderWinback(firstName: string | null): Rendered {
  return {
    subject: "Your Norva catalog is waiting",
    html: shell({
      heading: "Come back to Norva",
      bodyHtml: `${greet(firstName)}<br><br>
        Your Norva account, sources and preferences are still here. Reactivate anytime and pick up your catalog on every screen, right where you left off.`,
      cta: { label: "Reactivate Norva", url: SUBSCRIBE_URL },
      note: `No longer need Norva? You can ignore this — we won't email you about this again.`,
    }),
  };
}

// Checkout-abandonment reminder: the user opened a checkout (card check) but never
// completed it. One email, sent 1–48h later (recovery peaks within the hour);
// deep-links back into the checkout with the plan/period they had picked.
export function renderAbandonedCheckout(firstName: string | null, opts: { plan?: string; period?: string }): Rendered {
  const plan = opts.plan === "family" ? "family" : "plus";
  const period = opts.period === "annual" ? "annual" : "monthly";
  const planName = plan === "family" ? "Norva Family" : "Norva";
  const url = `${SITE_URL}/checkout.html?plan=${plan}&period=${period}`;
  return {
    subject: "Your Norva free trial is one step away",
    html: shell({
      heading: "Finish setting up your free trial",
      bodyHtml: `${greet(firstName)}<br><br>
        You were one step away from starting your <b style="color:#cdd6e6">${planName}</b> free trial —
        the quick card check wasn't completed. There is <b style="color:#cdd6e6">no charge today</b>:
        we only place a temporary €0.50 authorization that is released right away and never debited.
        Your 7 days of full access start the moment the check completes.`,
      cta: { label: "Finish setup", url },
      note: `Changed your mind? Just ignore this — nothing was charged and nothing will be.`,
    }),
  };
}
