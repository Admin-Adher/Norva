// Catalog-import transactional emails. Pure render functions: delivery, leasing and
// idempotency remain owned by norva-import-notify.

const SITE_URL = "https://norva.tv";
const OPEN_URL = `${SITE_URL}/app.html`;
const SUPPORT_EMAIL = "support@norva.tv";
const SUPPORT_URL = `mailto:${SUPPORT_EMAIL}`;

export interface ProviderStat {
  name: string;
  movies?: number;
  series?: number;
  channels?: number;
}

export interface EmailTag {
  name: "app" | "category" | "flow";
  value: string;
}

export interface RenderedImportEmail {
  subject: string;
  html: string;
  text: string;
  tags: EmailTag[];
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function textValue(s: unknown, fallback = ""): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim() || fallback;
}

function num(n: number | undefined): string {
  return typeof n === "number" && n > 0 ? n.toLocaleString("en-US") : "";
}

function tags(flow: "import_started" | "import_completed" | "import_failed"): EmailTag[] {
  return [
    { name: "app", value: "norva" },
    { name: "category", value: "transactional" },
    { name: "flow", value: flow },
  ];
}

export function importEmailTags(kind: string): EmailTag[] {
  if (kind === "import_started" || kind === "import_completed" || kind === "import_failed") return tags(kind);
  return [
    { name: "category", value: "transactional" },
    { name: "flow", value: "import_unknown" },
  ];
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;|&zwnj;/gi, " ")
    .replace(/&middot;/gi, "·")
    .replace(/&copy;/gi, "©")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// The import outbox freezes HTML + subject before network I/O. Derive the text
// alternative from that frozen HTML so a retry keeps one coherent immutable body.
export function plainTextFromImportHtml(html: string): string {
  const stripTags = (value: string) => decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").trim();
  return decodeEntities(String(html ?? "")
    .replace(/<div\b[^>]*data-preheader="true"[^>]*>[\s\S]*?<\/div>/i, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, "")
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/gi, "")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const labelText = stripTags(label);
      const decodedHref = decodeEntities(href);
      if (decodedHref.toLowerCase() === `mailto:${labelText.toLowerCase()}`) return labelText;
      return `${labelText} (${decodedHref})`;
    })
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:h1|h2|p|div|td|tr|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function providerCard(p: ProviderStat, withStats: boolean): string {
  const parts = withStats
    ? [
        num(p.movies) && `${num(p.movies)} movies`,
        num(p.series) && `${num(p.series)} series`,
        num(p.channels) && `${num(p.channels)} channels`,
      ].filter(Boolean)
    : [];
  const stats = parts.length
    ? `<tr><td style="padding:5px 16px 14px;color:#aeb8cc;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5">${parts.join(" &middot; ")}</td></tr>`
    : "";
  return `<tr><td style="padding:0 0 8px">
    <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#171c26" style="width:100%;background:#171c26;border:1px solid #303a4d;border-radius:10px;border-collapse:separate">
      <tr><td style="padding:${parts.length ? "14px 16px 0" : "14px 16px"};color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:1.45">${esc(textValue(p.name, "Your provider"))}</td></tr>
      ${stats}
    </table>
  </td></tr>`;
}

function button(label: string, url: string): string {
  return `<tr><td align="center" style="padding:8px 32px 30px">
    <table role="presentation" border="0" cellpadding="0" cellspacing="0"><tr>
      <td align="center" bgcolor="#5b7cfa" style="background:#5b7cfa;border-radius:10px;mso-padding-alt:14px 30px">
        <a href="${esc(url)}" style="display:inline-block;padding:14px 30px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;line-height:1;text-decoration:none">${esc(label)}</a>
      </td>
    </tr></table>
  </td></tr>`;
}

function shell(opts: {
  title: string;
  preheader: string;
  heading: string;
  intro: string;
  providers?: ProviderStat[];
  withStats?: boolean;
  cta?: { label: string; url: string };
  note?: string;
}): string {
  const list = (opts.providers ?? []).length
    ? `<tr><td style="padding:4px 32px 18px">
         <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0">
           ${(opts.providers ?? []).map((p) => providerCard(p, Boolean(opts.withStats))).join("")}
         </table>
       </td></tr>`
    : "";
  const cta = opts.cta ? button(opts.cta.label, opts.cta.url) : "";
  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:#0a0c11;color:#f8fafc;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
  <div data-preheader="true" style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${esc(opts.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0a0c11" style="width:100%;background:#0a0c11;border-collapse:collapse">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="500" border="0" cellpadding="0" cellspacing="0" bgcolor="#11151d" style="width:100%;max-width:500px;background:#11151d;border:1px solid #283143;border-radius:16px;border-collapse:separate">
        <tr><td align="center" style="padding:32px 32px 8px">
          <img src="${SITE_URL}/img/norva-app-icon.png" width="48" height="48" alt="" aria-hidden="true" style="display:block;width:48px;height:48px;border:0;border-radius:12px;outline:none;text-decoration:none">
          <p style="margin:10px 0 0;color:#ffffff;font-family:'Century Gothic',Arial,Helvetica,sans-serif;font-size:22px;font-weight:600;letter-spacing:-.02em;line-height:1.25">Norva</p>
        </td></tr>
        <tr><td align="center" style="padding:18px 32px 6px">
          <h1 style="margin:0;color:#f8fafc;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;line-height:1.3">${esc(opts.heading)}</h1>
        </td></tr>
        <tr><td style="padding:10px 32px 18px;text-align:left;color:#bcc5d6;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65">${opts.intro}</td></tr>
        ${list}${cta}
        <tr><td style="padding:20px 32px 28px;border-top:1px solid #283143;color:#9ba6ba;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;text-align:center">
          ${opts.note ?? `You are receiving this because you added a provider to your Norva account. Questions? <a href="${SUPPORT_URL}" style="color:#b8c8f2;text-decoration:underline">${SUPPORT_EMAIL}</a>.`}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#8994a8;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5">&copy; Norva</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function greetHtml(firstName?: string | null): string {
  const n = textValue(firstName);
  return n ? `Hi ${esc(n)},` : "Hi,";
}

function greetText(firstName?: string | null): string {
  const n = textValue(firstName);
  return n ? `Hi ${n},` : "Hi,";
}

function providerNamesHtml(providers: ProviderStat[]): string {
  const names = providers.map((p) => `<strong style="color:#e3e8f2">${esc(textValue(p.name, "your provider"))}</strong>`);
  if (names.length === 0) return "your provider";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function providerNamesText(providers: ProviderStat[]): string {
  const names = providers.map((p) => textValue(p.name, "your provider"));
  if (names.length === 0) return "your provider";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function providerStatsText(providers: ProviderStat[]): string {
  return providers.map((p) => {
    const stats = [
      num(p.movies) && `${num(p.movies)} movies`,
      num(p.series) && `${num(p.series)} series`,
      num(p.channels) && `${num(p.channels)} channels`,
    ].filter(Boolean);
    return `- ${textValue(p.name, "Your provider")}${stats.length ? `: ${stats.join(", ")}` : ""}`;
  }).join("\n");
}

export function renderImportStarted(firstName: string | null, providers: ProviderStat[]): RenderedImportEmail {
  const many = providers.length > 1;
  const subject = many ? "We're building your catalogs — Norva" : `We're building your ${textValue(providers[0]?.name, "catalog")} — Norva`;
  const text = `${greetText(firstName)}

Thanks for trusting Norva. We're building your ${providerNamesText(providers)} ${many ? "catalogs" : "catalog"} now. Large providers can take a few minutes. You can safely close the app; we'll email you as soon as ${many ? "they are" : "it is"} ready.

${providerStatsText(providers)}

We'll send another email when your catalog is ready to watch.

Questions? ${SUPPORT_EMAIL}
© Norva`;
  return {
    subject,
    text,
    tags: tags("import_started"),
    html: shell({
      title: subject,
      preheader: "Norva is building your catalog. You can safely close the app.",
      heading: many ? "We're building your catalogs" : "We're building your catalog",
      intro: `${greetHtml(firstName)}<br><br>Thanks for trusting Norva. We're building your ${providerNamesHtml(providers)} ${many ? "catalogs" : "catalog"} now. Large providers can take a few minutes. You can safely close the app; we'll email you as soon as ${many ? "they are" : "it is"} ready.`,
      providers,
      withStats: false,
      note: "We'll send another email when your catalog is ready to watch.",
    }),
  };
}

export function renderImportCompleted(firstName: string | null, providers: ProviderStat[]): RenderedImportEmail {
  const many = providers.length > 1;
  const subject = many ? "Your catalogs are ready — Norva" : `Your ${textValue(providers[0]?.name, "catalog")} is ready — Norva`;
  const text = `${greetText(firstName)}

Your ${providerNamesText(providers)} ${many ? "catalogs are" : "catalog is"} ready to watch.

${providerStatsText(providers)}

Open Norva: ${OPEN_URL}

Questions? ${SUPPORT_EMAIL}
© Norva`;
  return {
    subject,
    text,
    tags: tags("import_completed"),
    html: shell({
      title: subject,
      preheader: many ? "Your Norva catalogs are ready to watch." : "Your Norva catalog is ready to watch.",
      heading: many ? "Your catalogs are ready" : "Your catalog is ready",
      intro: `${greetHtml(firstName)}<br><br>Your ${providerNamesHtml(providers)} ${many ? "catalogs are" : "catalog is"} ready to watch.`,
      providers,
      withStats: true,
      cta: { label: "Open Norva", url: OPEN_URL },
    }),
  };
}

export function renderImportFailed(firstName: string | null, providers: ProviderStat[]): RenderedImportEmail {
  const many = providers.length > 1;
  const subject = many ? "We hit a snag with some imports — Norva" : `We hit a snag importing ${textValue(providers[0]?.name, "your provider")} — Norva`;
  const text = `${greetText(firstName)}

We ran into a problem importing your ${providerNamesText(providers)} ${many ? "catalogs" : "catalog"}. We retry automatically, so there is nothing you need to do right now. If the issue persists, our support team is ready to help.

${providerStatsText(providers)}

Contact support: ${SUPPORT_EMAIL}

Sometimes a provider is temporarily unavailable; Norva retries automatically.
© Norva`;
  return {
    subject,
    text,
    tags: tags("import_failed"),
    html: shell({
      title: subject,
      preheader: "Norva will retry this catalog import automatically; no action is needed.",
      heading: "We hit a snag",
      intro: `${greetHtml(firstName)}<br><br>We ran into a problem importing your ${providerNamesHtml(providers)} ${many ? "catalogs" : "catalog"}. We retry automatically, so there is nothing you need to do right now. If the issue persists, our support team is ready to help.`,
      providers,
      withStats: false,
      cta: { label: "Contact support", url: SUPPORT_URL },
      note: "Sometimes a provider is temporarily unavailable; Norva retries automatically.",
    }),
  };
}
