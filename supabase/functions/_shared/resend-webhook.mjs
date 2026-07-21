const ALLOWED_EVENTS = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "email.opened",
  "email.clicked",
]);

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export function eventTypeAllowed(value) {
  return typeof value === "string" && ALLOWED_EVENTS.has(value);
}

export async function verifyWebhookSignature({ secret, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const normalizedSecret = String(secret ?? "")
    .replace(/^v1,whsec_/, "")
    .replace(/^whsec_/, "");
  if (!normalizedSecret) return false;

  const eventId = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signatures = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!eventId || !timestamp || !signatures) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > 300) return false;

  let keyBytes;
  try {
    keyBytes = Uint8Array.from(atob(normalizedSecret), (character) => character.charCodeAt(0));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signedContent = `${eventId}.${timestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  return signatures
    .trim()
    .split(/\s+/)
    .map((entry) => {
      const separator = entry.indexOf(",");
      return separator >= 0 ? entry.slice(separator + 1) : entry;
    })
    .some((signature) => timingSafeEqual(signature, expected));
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function shortText(value, max = 500) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function safeDiagnosticText(value) {
  const normalized = shortText(value, 300);
  if (!normalized) return null;
  return normalized
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gu, "[redacted-email]")
    .replace(/https?:\/\/\S+/giu, "[redacted-url]");
}

export function normalizedRecipients(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter((email) => email.length >= 3 && email.length <= 320 && email.includes("@")))]
    .slice(0, 20);
}

export function safeTags(value) {
  const entries = Array.isArray(value)
    ? value.slice(0, 20).flatMap((entry) => {
        const tag = record(entry);
        return typeof tag.name === "string" ? [[tag.name, tag.value]] : [];
      })
    : Object.entries(record(value)).slice(0, 20);
  return Object.fromEntries(entries.flatMap(([rawKey, rawValue]) => {
    const key = String(rawKey ?? "").trim().slice(0, 100);
    const value = shortText(rawValue, 200);
    return key && /^[A-Za-z0-9_-]+$/.test(key) && value ? [[key, value]] : [];
  }));
}

export function norvaEventAllowed(fromValue, tagsValue) {
  const from = String(fromValue ?? "").trim().toLowerCase();
  const tags = safeTags(tagsValue);
  // The webhook is team-wide and the team is shared with another product.
  // Require both an explicit product tag and Norva's verified sender domain.
  return tags.app === "norva" && /(?:^|<)[^<>@\s]+@norva\.tv>?$/.test(from);
}

export function safeDiagnosticData(eventType, dataValue) {
  const data = record(dataValue);
  const source = eventType === "email.bounced"
    ? record(data.bounce)
    : eventType === "email.suppressed"
    ? record(data.suppressed)
    : eventType === "email.failed"
    ? record(data.failed)
    : eventType === "email.delivery_delayed"
    ? record(data.delayed ?? data.delivery_delayed)
    : {};

  const diagnostic = {};
  for (const [target, candidates] of Object.entries({
    type: ["type"],
    subtype: ["subType", "subtype"],
    // Bounce payloads expose the useful SMTP/provider explanation as
    // `message`; keep its redacted form as a bounded diagnostic fallback.
    reason: ["reason", "message"],
  })) {
    const value = candidates.map((key) => safeDiagnosticText(source[key])).find(Boolean);
    if (value) diagnostic[target] = value;
  }
  return diagnostic;
}
