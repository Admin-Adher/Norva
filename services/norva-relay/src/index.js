const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_ALLOWED_ORIGINS = [
  "https://norva-eight.vercel.app",
  "https://norva-pgkk.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return json(request, env, {
          ok: true,
          service: "norva-relay",
          time: new Date().toISOString(),
        });
      }

      if (!url.pathname.startsWith("/relay/")) {
        return json(request, env, { error: "Route not found" }, 404);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(request, env, { error: "Method not allowed" }, 405);
      }

      const token = decodeURIComponent(url.pathname.slice("/relay/".length));
      const claims = await verifyRelayToken(token, env.RELAY_TOKEN_SECRET);
      if (claims.exp * 1000 < Date.now()) {
        return json(request, env, { error: "Relay token expired" }, 401);
      }

      return proxyPlayback(request, env, claims);
    } catch (error) {
      console.error(JSON.stringify({
        service: "norva-relay",
        error: error instanceof Error ? error.message : String(error),
      }));
      return json(request, env, { error: "Relay request failed" }, 500);
    }
  },
};

async function proxyPlayback(request, env, claims) {
  const targetUrl = new URL(claims.url);
  const headers = new Headers();
  copyHeader(request.headers, headers, "accept");
  copyHeader(request.headers, headers, "accept-language");
  copyHeader(request.headers, headers, "range");
  copyHeader(request.headers, headers, "user-agent");

  const upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    redirect: "follow",
  });

  const responseHeaders = filteredResponseHeaders(upstream.headers);
  mergeCors(responseHeaders, corsHeaders(request, env));
  responseHeaders.set("Cache-Control", "private, max-age=30");

  if (request.method === "HEAD" || !isHlsPlaylist(targetUrl, upstream.headers)) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  const contentLength = Number.parseInt(upstream.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  const playlist = await upstream.text();
  const rewritten = await rewriteHlsPlaylist(playlist, targetUrl, claims, env);
  responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
  responseHeaders.delete("Content-Length");

  return new Response(rewritten, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function rewriteHlsPlaylist(playlist, baseUrl, claims, env) {
  const lines = playlist.split(/\r?\n/);
  const rewritten = [];

  for (const line of lines) {
    if (!line || line.startsWith("#EXTM3U")) {
      rewritten.push(line);
      continue;
    }

    if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP")) {
      rewritten.push(await rewriteUriAttribute(line, baseUrl, claims, env));
      continue;
    }

    if (line.startsWith("#")) {
      rewritten.push(line);
      continue;
    }

    rewritten.push(await signedRelayUrl(new URL(line, baseUrl).href, claims, env));
  }

  return rewritten.join("\n");
}

async function rewriteUriAttribute(line, baseUrl, claims, env) {
  const match = line.match(/URI="([^"]+)"/);
  if (!match) return line;
  const signed = await signedRelayUrl(new URL(match[1], baseUrl).href, claims, env);
  return line.replace(match[0], `URI="${signed}"`);
}

async function signedRelayUrl(targetUrl, claims, env) {
  const payload = JSON.stringify({
    v: 1,
    sid: claims.sid,
    uid: claims.uid,
    url: targetUrl,
    exp: claims.exp,
  });
  const signature = await hmacBase64Url(env.RELAY_TOKEN_SECRET, payload);
  const token = `${base64Url(encoder.encode(payload))}.${signature}`;
  return `${env.PUBLIC_BASE_URL ?? ""}/relay/${token}`.replace(/^\/relay/, "/relay");
}

async function verifyRelayToken(token, secret) {
  if (!secret) throw new Error("Missing RELAY_TOKEN_SECRET");
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) throw new Error("Malformed relay token");

  const payload = base64UrlDecode(payloadPart);
  const expected = await hmacBase64Url(secret, payload);
  if (!timingSafeEqual(signaturePart, expected)) {
    throw new Error("Invalid relay token signature");
  }

  const claims = JSON.parse(payload);
  if (!claims || claims.v !== 1 || !claims.sid || !claims.uid || !claims.url || !claims.exp) {
    throw new Error("Invalid relay token claims");
  }
  const url = new URL(claims.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Unsupported target protocol");
  }
  return claims;
}

async function hmacBase64Url(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return decoder.decode(bytes);
}

function timingSafeEqual(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function isHlsPlaylist(targetUrl, headers) {
  const contentType = headers.get("content-type") ?? "";
  return (
    contentType.includes("application/vnd.apple.mpegurl") ||
    contentType.includes("application/x-mpegurl") ||
    targetUrl.pathname.toLowerCase().endsWith(".m3u8")
  );
}

function filteredResponseHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      result.set(name, value);
    }
  }
  return result;
}

function copyHeader(from, to, name) {
  const value = from.get(name);
  if (value) to.set(name, value);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const configured = String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin) || isLocalOrigin(origin))
    ? origin
    : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, range, content-type",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function mergeCors(headers, cors) {
  for (const [name, value] of Object.entries(cors)) {
    headers.set(name, value);
  }
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
