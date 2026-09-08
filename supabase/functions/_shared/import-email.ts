import { renderEmailFrame } from "./email-frame.ts";
// Catalog-import transactional emails. Pure render functions: delivery, leasing and
// idempotency remain owned by norva-import-notify.

const SITE_URL = "https://norva.tv";
// These are static product routes. No source ID, private URL or behavioral
// delivery ID belongs in a transactional email's navigation link.
const SOURCES_URL = `${SITE_URL}/app.html#settings/sources`;
const CATALOG_URL = `${SITE_URL}/app.html#home`;
const SUPPORT_EMAIL = "support@norva.tv";
const SUPPORT_URL = `mailto:${SUPPORT_EMAIL}`;

export interface ProviderStat {
  name: string;
  movies?: number;
  series?: number;
  channels?: number;
  failureDisposition?: "action_required" | "unknown";
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

function shell(opts: {
  title: string; preheader: string; heading: string; intro: string;
  providers?: ProviderStat[]; withStats?: boolean; cta?: { label: string; url: string }; note?: string;
  artwork?: 'catalog' | 'action';
}): string {
  const list = (opts.providers ?? []).length
    ? `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" style="width:100%;margin-top:24px">${(opts.providers ?? []).map(p => providerCard(p, Boolean(opts.withStats))).join("")}</table>`
    : "";
  return renderEmailFrame({ ...opts, artwork: opts.artwork ?? 'catalog', bodyHtml: opts.intro + list,
    noteHtml: opts.note ?? `You are receiving this because you added a provider to your Norva account. Questions? <a href="${SUPPORT_URL}" style="color:#60A5FA;text-decoration:underline">${SUPPORT_EMAIL}</a>.`,
  });
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

Check import status: ${SOURCES_URL}

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
      cta: { label: "Check import status", url: SOURCES_URL },
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

View my catalog: ${CATALOG_URL}

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
      cta: { label: "View my catalog", url: CATALOG_URL },
    }),
  };
}

export function renderImportFailed(firstName: string | null, providers: ProviderStat[]): RenderedImportEmail {
  const many = providers.length > 1;
  const actionRequired = providers.some((provider) => provider.failureDisposition === "action_required");
  const guidance = actionRequired
    ? "At least one import has stopped and needs your attention. Check your provider access before trying again."
    : "Open Norva to check the import status before trying again. We cannot confirm that an automatic retry is scheduled.";
  const help = "For M3U, use the full playlist URL supplied by your provider. For Xtream, check the server URL, username and password. A website address or an app-only login may not be enough. Never email us your password or private playlist URL.";
  const subject = many ? "We hit a snag with some imports — Norva" : `We hit a snag importing ${textValue(providers[0]?.name, "your provider")} — Norva`;
  const text = `${greetText(firstName)}

We ran into a problem importing your ${providerNamesText(providers)} ${many ? "catalogs" : "catalog"}. ${guidance}

${providerStatsText(providers)}

${help}

Review my source: ${SOURCES_URL}
Contact support: ${SUPPORT_EMAIL}

© Norva`;
  return {
    subject,
    text,
    tags: tags("import_failed"),
    html: shell({ artwork: 'action',
      title: subject,
      preheader: actionRequired ? "Check your provider access to continue your import." : "Check your import status in Norva.",
      heading: "We hit a snag",
      intro: `${greetHtml(firstName)}<br><br>We ran into a problem importing your ${providerNamesHtml(providers)} ${many ? "catalogs" : "catalog"}. ${esc(guidance)}`,
      providers,
      withStats: false,
      cta: { label: "Review my source", url: SOURCES_URL },
      note: `${help} Need help? ${SUPPORT_EMAIL}`,
    }),
  };
}
