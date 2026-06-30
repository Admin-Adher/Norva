// Firebase Cloud Messaging HTTP v1 sender (Deno). Auth = a Google service-account (the legacy "server
// key" API is deprecated): we sign a JWT with the account's private key (RS256 via Web Crypto), exchange
// it for a short-lived OAuth access token, and POST to the v1 send endpoint. The service-account JSON is
// supplied as the env secret FCM_SERVICE_ACCOUNT (the file Firebase Console → Project settings → Service
// accounts → "Generate new private key" produces). No external deps.
//
// Public API:
//   await sendFcmPush(token, { title, body, data }) -> { ok, status, error?, unregistered? }
//   `unregistered: true` means the token is dead (UNREGISTERED / invalid) and the caller should delete it.

interface ServiceAccount { client_email: string; private_key: string; project_id: string }

let saCache: ServiceAccount | null = null;
function serviceAccount(): ServiceAccount | null {
  if (saCache) return saCache;
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT") ?? "";
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw) as ServiceAccount;
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
    saCache = sa;
    return sa;
  } catch { return null; }
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str: string): string { return b64url(new TextEncoder().encode(str)); }

// Import a PEM PKCS#8 private key for RS256 signing.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

let tokenCache: { value: string; exp: number } | null = null;
async function accessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.exp - 60 > now) return tokenCache.value;
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) { console.error("[fcm] token exchange failed", res.status, await res.text().catch(() => "")); return null; }
  const json = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  tokenCache = { value: json.access_token, exp: now + (json.expires_in ?? 3600) };
  return json.access_token;
}

export function fcmConfigured(): boolean { return serviceAccount() !== null; }

export async function sendFcmPush(
  token: string,
  msg: { title: string; body: string; data?: Record<string, string> },
): Promise<{ ok: boolean; status: number; error?: string; unregistered?: boolean }> {
  const sa = serviceAccount();
  if (!sa) return { ok: false, status: 0, error: "FCM not configured" };
  const at = await accessToken(sa);
  if (!at) return { ok: false, status: 0, error: "token exchange failed" };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: msg.title, body: msg.body },
        data: msg.data ?? {},
        android: { priority: "high", notification: { default_sound: true } },
      },
    }),
  });
  if (res.ok) return { ok: true, status: res.status };
  const text = await res.text().catch(() => "");
  // A dead token surfaces as 404 UNREGISTERED or 400 with INVALID_ARGUMENT on the token.
  const unregistered = res.status === 404 || /UNREGISTERED|NOT_FOUND/i.test(text);
  return { ok: false, status: res.status, error: text.slice(0, 300), unregistered };
}
