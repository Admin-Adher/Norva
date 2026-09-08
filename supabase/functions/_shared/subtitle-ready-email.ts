import { renderEmailFrame } from "./email-frame.ts";
const NORVA_SITE = "https://norva.tv";
const SUPPORT_EMAIL = "support@norva.tv";

export interface SubtitleReadyEmail {
  subject: string;
  html: string;
  text: string;
  tags: Array<{ name: "app" | "category" | "flow"; value: string }>;
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
}

function cleanText(value: unknown, fallback: string): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 180) || fallback;
}

function safeHttpUrl(value: unknown, fallback: string): string {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol === "https:") return url.toString();
  } catch (_) { /* use the trusted fallback */ }
  return fallback;
}

export function renderSubtitleReadyEmail(options: {
  titleLabel?: string | null;
  siteUrl?: string | null;
  ctaUrl?: string | null;
}): SubtitleReadyEmail {
  const title = cleanText(options.titleLabel, "your title");
  const siteUrl = safeHttpUrl(options.siteUrl, NORVA_SITE);
  const ctaUrl = safeHttpUrl(options.ctaUrl, siteUrl);
  const hasDeepLink = ctaUrl !== siteUrl;
  const subject = `Your AI subtitles for “${title}” are ready — Norva`;
  const ctaLabel = hasDeepLink ? "Open with AI subtitles" : "Open Norva";
  const preheader = `AI subtitles for ${title} are ready and cached for your next watch.`;
  const text = `Your AI subtitles are ready

Norva finished transcribing ${title}. Open the title and choose “AI subtitles” in the captions menu.

${ctaLabel}: ${ctaUrl}

You are receiving this because you asked Norva to notify you when these subtitles were ready. They are cached and will load immediately next time.

Questions? ${SUPPORT_EMAIL}
Norva is a media player and includes no content.
© Norva`;

  return {
    subject,
    text,
    tags: [
      { name: "app", value: "norva" },
      { name: "category", value: "transactional" },
      { name: "flow", value: "subtitle_ready" },
    ],
    html: renderEmailFrame({ artwork: 'catalog', title: subject, heading: "Your AI subtitles are ready", preheader,
      bodyHtml: `<p style="margin:0">Norva finished transcribing <strong>${esc(title)}</strong>. Open the title and choose <strong>AI subtitles</strong> in the captions menu.</p>`,
      cta: { label: ctaLabel, url: ctaUrl },
      noteHtml: `You are receiving this because you asked Norva to notify you when these subtitles were ready. They are cached and will load immediately next time.<br><br>Questions? <a href="mailto:${SUPPORT_EMAIL}" style="color:#60A5FA;text-decoration:underline">${SUPPORT_EMAIL}</a>. Norva is a media player and includes no content.`,
    }),
  };
}
