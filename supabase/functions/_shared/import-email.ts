// Phase 1 import-lifecycle email templates (English-only — Norva is English-only). Pure render
// functions, no side effects: the digest cron builds the recipient list + provider data and calls
// these, then sends via Resend. Branding mirrors norva-auth-email's `shell()` (dark theme, table +
// inline styles, email-client-safe). Each renderer takes an ARRAY of providers, so the SAME function
// produces a single-provider email (length 1) or a grouped digest (length N).

const SITE_URL = "https://norva.tv";
const OPEN_URL = `${SITE_URL}/app.html`;
const SUPPORT_URL = "mailto:support@norva.tv";

export interface ProviderStat {
  name: string;
  movies?: number;
  series?: number;
  channels?: number;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function num(n: number | undefined): string {
  return typeof n === "number" && n > 0 ? n.toLocaleString("en-US") : "";
}

// One provider "card": name + (optional) stat line. Used for both single and digest layouts.
function providerCard(p: ProviderStat, withStats: boolean): string {
  const parts = withStats
    ? [
        num(p.movies) && `${num(p.movies)} movies`,
        num(p.series) && `${num(p.series)} series`,
        num(p.channels) && `${num(p.channels)} channels`,
      ].filter(Boolean)
    : [];
  const stats = parts.length
    ? `<div style="color:#9aa6bd;font-size:13px;margin-top:4px">${parts.join("  ·  ")}</div>`
    : "";
  return `<tr><td style="padding:6px 0">
    <div style="background:#161b24;border:1px solid #2a3344;border-radius:10px;padding:14px 16px;text-align:left">
      <div style="color:#f8fafc;font-size:15px;font-weight:700">${esc(p.name)}</div>
      ${stats}
    </div></td></tr>`;
}

function shell(opts: {
  heading: string;
  intro: string;
  providers?: ProviderStat[];
  withStats?: boolean;
  cta?: { label: string; url: string };
  note?: string;
}): string {
  const list = (opts.providers ?? []).length
    ? `<tr><td style="padding:4px 32px 18px">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
           ${(opts.providers ?? []).map((p) => providerCard(p, Boolean(opts.withStats))).join("")}
         </table>
       </td></tr>`
    : "";
  const button = opts.cta
    ? `<tr><td align="center" style="padding:6px 0 28px">
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
        <tr><td style="padding:10px 32px 18px;text-align:center;color:#9aa6bd;font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${opts.intro}</td></tr>
        ${list}${button}
        <tr><td style="padding:18px 32px 28px;border-top:1px solid #1f2733;color:#5f6b85;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          ${opts.note ?? "You're receiving this because you added a provider to your Norva account."}
        </td></tr>
      </table>
      <div style="color:#3b4254;font-family:Arial,sans-serif;font-size:11px;margin-top:16px">© Norva</div>
    </td></tr>
  </table>
</body></html>`;
}

// "Hi Adrien — " when we know the first name, else "Hi — ".
function greet(firstName?: string | null): string {
  const n = (firstName ?? "").trim();
  return n ? `Hi ${esc(n)} — ` : "";
}

function provNames(providers: ProviderStat[]): string {
  const names = providers.map((p) => `<b style="color:#cdd6e6">${esc(p.name)}</b>`);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function renderImportStarted(firstName: string | null, providers: ProviderStat[]): { subject: string; html: string } {
  const many = providers.length > 1;
  return {
    subject: many ? "We're building your catalogs — Norva" : `We're building your ${providers[0]?.name ?? "catalog"} — Norva`,
    html: shell({
      heading: many ? "We're on it 🎬" : "Building your catalog 🎬",
      intro: `${greet(firstName)}thanks for trusting Norva. We're building your ${provNames(providers)} ${many ? "catalogs" : "catalog"} right now. Large providers can take a few minutes — we'll email you the moment ${many ? "they're" : "it's"} ready. Feel free to close the app.`,
      providers,
      withStats: false,
      note: "We'll send another email when your catalog is ready to watch.",
    }),
  };
}

export function renderImportCompleted(firstName: string | null, providers: ProviderStat[]): { subject: string; html: string } {
  const many = providers.length > 1;
  return {
    subject: many ? "Your catalogs are ready — Norva" : `Your ${providers[0]?.name ?? "catalog"} is ready — Norva`,
    html: shell({
      heading: many ? "Your catalogs are ready ✨" : "Your catalog is ready ✨",
      intro: `${greet(firstName)}your ${provNames(providers)} ${many ? "catalogs are" : "catalog is"} ready to watch.`,
      providers,
      withStats: true,
      cta: { label: "Open Norva", url: OPEN_URL },
    }),
  };
}

export function renderImportFailed(firstName: string | null, providers: ProviderStat[]): { subject: string; html: string } {
  const many = providers.length > 1;
  return {
    subject: many ? "We hit a snag with some imports — Norva" : `We hit a snag importing ${providers[0]?.name ?? "your provider"} — Norva`,
    html: shell({
      heading: "We hit a snag",
      intro: `${greet(firstName)}we ran into a problem importing your ${provNames(providers)} ${many ? "catalogs" : "catalog"}. We're already looking into it — there's nothing you need to do. If it doesn't resolve, our team is here to help.`,
      providers,
      withStats: false,
      cta: { label: "Contact support", url: SUPPORT_URL },
      note: "Sometimes a provider is temporarily unavailable; we retry automatically.",
    }),
  };
}
