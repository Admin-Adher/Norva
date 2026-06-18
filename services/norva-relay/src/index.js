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

const DEFAULT_IMAGE_FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 960"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#0a1020"/><stop offset="1" stop-color="#1a1230"/></linearGradient><linearGradient id="n" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#26d9ff"/><stop offset=".55" stop-color="#5b79ff"/><stop offset="1" stop-color="#d348ff"/></linearGradient></defs><rect width="640" height="960" rx="48" fill="url(#g)"/><path d="M182 628V354c0-36 29-65 65-65s65 29 65 65v74l85-94c33-37 95-13 95 37v235c0 36-29 65-65 65s-65-29-65-65v-64l-85 94c-33 37-95 13-95-37z" fill="none" stroke="url(#n)" stroke-width="50" stroke-linecap="round" stroke-linejoin="round"/><text x="320" y="790" text-anchor="middle" fill="#dce6ff" font-family="Arial, Helvetica, sans-serif" font-size="42" font-weight="700">Norva</text></svg>`;

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return json(request, env, {
          ok: true,
          service: "norva-edge",
          components: {
            relay: true,
            imageProxy: true,
            sessionCoordinator: Boolean(env.PROVIDER_SESSION_COORDINATOR),
            mediaGatewayConfigured: Boolean(env.NORVA_MEDIA_GATEWAY_URL && env.NORVA_MEDIA_GATEWAY_TOKEN),
          },
          time: new Date().toISOString(),
        });
      }

      if (url.pathname === "/image") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json(request, env, { error: "Method not allowed" }, 405);
        }
        return await proxyImage(request, env, ctx, url);
      }

      if (url.pathname.startsWith("/sessions/")) {
        await requireServiceBearer(request, env);
        return await routeSessionCoordinator(request, env);
      }

      if (url.pathname.startsWith("/relay/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json(request, env, { error: "Method not allowed" }, 405);
        }
        const token = decodeURIComponent(url.pathname.slice("/relay/".length));
        const claims = await verifyRelayToken(token, env.RELAY_TOKEN_SECRET);
        if (claims.exp * 1000 < Date.now()) {
          return json(request, env, { error: "Relay token expired" }, 401);
        }
        return await proxyPlayback(request, env, claims);
      }

      return json(request, env, { error: "Route not found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Norva Edge request failed";
      console.error(JSON.stringify({
        service: "norva-edge",
        status,
        error: message,
        details: error instanceof HttpError ? error.details : undefined,
      }));
      return json(request, env, {
        error: message,
        details: error instanceof HttpError ? error.details : undefined,
      }, status);
    }
  },
};

export class ProviderSessionCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const action = url.pathname.split("/").filter(Boolean).pop();

      if (request.method === "GET" && action === "status") {
        return json(request, this.env, await this.status(url));
      }

      if (request.method !== "POST") {
        return json(request, this.env, { error: "Method not allowed" }, 405);
      }

      const body = await readJson(request);
      if (action === "prepare") return json(request, this.env, await this.prepare(body));
      if (action === "start") return json(request, this.env, await this.start(body));
      if (action === "end") return json(request, this.env, await this.end(body));
      if (action === "abort") return json(request, this.env, await this.abort(body));

      return json(request, this.env, { error: "Session coordinator route not found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Session coordinator failed";
      console.error(JSON.stringify({
        service: "norva-session-coordinator",
        status,
        error: message,
      }));
      return json(request, this.env, { error: message }, status);
    }
  }

  async status(url) {
    const state = await this.loadState();
    await this.saveState(state);
    return {
      ok: true,
      activeSessions: state.active.length,
      pendingLocks: state.locks.length,
      sessions: state.active.map(publicSession),
      locks: state.locks.map(publicLock),
    };
  }

  async prepare(body) {
    const ownerKey = stringOrNull(body.ownerKey ?? body.owner_key);
    if (!ownerKey) throw new HttpError(400, "ownerKey is required");

    const state = await this.loadState();
    const sourceKey = stringOrNull(body.sourceKey ?? body.source_key ?? body.sourceId ?? body.source_id) || "account";
    const deviceKey = stringOrNull(body.deviceKey ?? body.device_key ?? body.deviceId ?? body.device_id) || "";
    const now = Date.now();
    const expireExisting = body.expireExisting !== false && body.expire_existing !== false;
    const conflicts = expireExisting
      ? state.active.filter((session) => isConflictingSession(session, { ownerKey, sourceKey, deviceKey }))
      : [];

    const gatewayExpired = await this.expireSessions(conflicts);
    state.active = state.active.filter((session) => !conflicts.some((conflict) => conflict.id === session.id));

    const lockTtlMs = boundedInt(body.lockTtlMs ?? body.lock_ttl_ms, 20_000, 2_000, 120_000);
    const lock = {
      id: crypto.randomUUID(),
      ownerKey,
      sourceKey,
      deviceKey,
      itemType: stringOrNull(body.itemType ?? body.item_type),
      itemId: stringOrNull(body.itemId ?? body.item_id),
      targetHash: stringOrNull(body.targetHash ?? body.target_hash),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + lockTtlMs).toISOString(),
    };
    state.locks.push(lock);
    await this.saveState(state);

    const waitMs = conflicts.length
      ? boundedInt(this.env.PROVIDER_SLOT_RELEASE_DELAY_MS, 1200, 0, 10_000)
      : 0;

    return {
      ok: true,
      lockId: lock.id,
      expiredSessions: conflicts.length,
      gatewayExpired,
      waitMs,
    };
  }

  async start(body) {
    const ownerKey = stringOrNull(body.ownerKey ?? body.owner_key);
    const sourceKey = stringOrNull(body.sourceKey ?? body.source_key ?? body.sourceId ?? body.source_id) || "account";
    if (!ownerKey) throw new HttpError(400, "ownerKey is required");

    const state = await this.loadState();
    const lockId = stringOrNull(body.lockId ?? body.lock_id);
    if (lockId) state.locks = state.locks.filter((lock) => lock.id !== lockId);

    const session = {
      id: crypto.randomUUID(),
      ownerKey,
      sourceKey,
      deviceKey: stringOrNull(body.deviceKey ?? body.device_key ?? body.deviceId ?? body.device_id) || "",
      playbackSessionId: stringOrNull(body.playbackSessionId ?? body.playback_session_id ?? body.sessionId),
      gatewaySessionId: stringOrNull(body.gatewaySessionId ?? body.gateway_session_id),
      itemType: stringOrNull(body.itemType ?? body.item_type),
      itemId: stringOrNull(body.itemId ?? body.item_id),
      targetHash: stringOrNull(body.targetHash ?? body.target_hash),
      createdAt: new Date().toISOString(),
      expiresAt: normalizeExpiresAt(body.expiresAt ?? body.expires_at),
    };

    state.active = state.active.filter((active) => {
      if (session.playbackSessionId && active.playbackSessionId === session.playbackSessionId) return false;
      return !isConflictingSession(active, session);
    });
    state.active.push(session);
    await this.saveState(state);

    return { ok: true, session: publicSession(session), activeSessions: state.active.length };
  }

  async end(body) {
    const state = await this.loadState();
    const playbackSessionId = stringOrNull(body.playbackSessionId ?? body.playback_session_id ?? body.sessionId);
    const gatewaySessionId = stringOrNull(body.gatewaySessionId ?? body.gateway_session_id);
    const ownerKey = stringOrNull(body.ownerKey ?? body.owner_key);
    const sourceKey = stringOrNull(body.sourceKey ?? body.source_key ?? body.sourceId ?? body.source_id);

    const matches = state.active.filter((session) => {
      if (playbackSessionId && session.playbackSessionId === playbackSessionId) return true;
      if (gatewaySessionId && session.gatewaySessionId === gatewaySessionId) return true;
      if (ownerKey && session.ownerKey === ownerKey && (!sourceKey || session.sourceKey === sourceKey)) return true;
      return false;
    });

    const gatewayExpired = await this.expireSessions(matches);
    state.active = state.active.filter((session) => !matches.some((match) => match.id === session.id));
    await this.saveState(state);

    return { ok: true, endedSessions: matches.length, gatewayExpired };
  }

  async abort(body) {
    const state = await this.loadState();
    const lockId = stringOrNull(body.lockId ?? body.lock_id);
    if (lockId) {
      state.locks = state.locks.filter((lock) => lock.id !== lockId);
      await this.saveState(state);
    }
    return { ok: true };
  }

  async loadState() {
    const now = Date.now();
    const state = (await this.state.storage.get("state")) || { active: [], locks: [] };
    state.active = (Array.isArray(state.active) ? state.active : []).filter((session) => {
      const expiresAt = Date.parse(session.expiresAt || "");
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
    state.locks = (Array.isArray(state.locks) ? state.locks : []).filter((lock) => {
      const expiresAt = Date.parse(lock.expiresAt || "");
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
    return state;
  }

  async saveState(state) {
    await this.state.storage.put("state", state);
  }

  async expireSessions(sessions) {
    if (!sessions.length || !this.env.NORVA_MEDIA_GATEWAY_URL || !this.env.NORVA_MEDIA_GATEWAY_TOKEN) return 0;
    let expired = 0;
    await Promise.allSettled(sessions.map(async (session) => {
      if (!session.gatewaySessionId) return;
      const response = await fetch(
        `${trimTrailingSlash(this.env.NORVA_MEDIA_GATEWAY_URL)}/sessions/${encodeURIComponent(session.gatewaySessionId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.env.NORVA_MEDIA_GATEWAY_TOKEN}` },
        },
      );
      if (response.ok || response.status === 404) {
        expired += 1;
      } else {
        console.warn("[norva-session-coordinator] gateway expiry refused", response.status);
      }
    }));
    return expired;
  }
}

async function routeSessionCoordinator(request, env) {
  if (!env.PROVIDER_SESSION_COORDINATOR) {
    return json(request, env, { error: "Session coordinator is not configured" }, 503);
  }
  const url = new URL(request.url);
  const body = request.method === "GET" ? Object.fromEntries(url.searchParams.entries()) : await readJson(request.clone());
  const ownerKey = stringOrNull(body.ownerKey ?? body.owner_key ?? body.userId ?? body.user_id ?? body.accountId ?? body.account_id);
  if (!ownerKey) return json(request, env, { error: "ownerKey is required" }, 400);
  const sourceKey = stringOrNull(body.sourceKey ?? body.source_key ?? body.sourceId ?? body.source_id) || "account";
  const objectName = await sha256Hex(`owner:${ownerKey}|source:${sourceKey}`);
  const id = env.PROVIDER_SESSION_COORDINATOR.idFromName(objectName);
  const stub = env.PROVIDER_SESSION_COORDINATOR.get(id);
  const response = await stub.fetch(request);
  const headers = new Headers(response.headers);
  mergeCors(headers, corsHeaders(request, env));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  const rewritten = await rewriteHlsPlaylist(playlist, targetUrl, claims, env, request);
  responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
  responseHeaders.delete("Content-Length");

  return new Response(rewritten, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function proxyImage(request, env, ctx, url) {
  const target = assertPublicImageUrl(url.searchParams.get("url") ?? "", env);
  const cacheKey = new Request(`${url.origin}/image?url=${encodeURIComponent(target.href)}`, request);
  const cache = caches.default;

  if (request.method === "GET") {
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached, request, env, { "X-Norva-Image-Cache": "HIT" });
  }

  const upstream = await fetch(target, {
    method: "GET",
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; NorvaEdgeImageProxy/1.0)",
    },
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtl: 86400,
    },
  }).catch(() => null);

  if (!upstream?.ok) {
    return fallbackImage(request, env);
  }

  const contentType = imageContentType(upstream.headers.get("content-type"), target.href);
  if (!contentType) {
    await upstream.body?.cancel?.();
    return fallbackImage(request, env);
  }

  const headers = filteredResponseHeaders(upstream.headers);
  mergeCors(headers, corsHeaders(request, env));
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Timing-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Norva-Image-Cache", "MISS");
  headers.delete("Set-Cookie");
  headers.delete("Content-Security-Policy");

  const response = new Response(request.method === "HEAD" ? null : upstream.body, {
    status: 200,
    headers,
  });
  if (request.method === "GET") ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function fallbackImage(request, env) {
  return new Response(request.method === "HEAD" ? null : DEFAULT_IMAGE_FALLBACK_SVG, {
    status: 200,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Timing-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "X-Norva-Image-Fallback": "1",
    },
  });
}

async function rewriteHlsPlaylist(playlist, baseUrl, claims, env, request) {
  const lines = playlist.split(/\r?\n/);
  const rewritten = [];

  for (const line of lines) {
    if (!line || line.startsWith("#EXTM3U")) {
      rewritten.push(line);
      continue;
    }

    if (line.startsWith("#EXT-X-KEY") || line.startsWith("#EXT-X-MAP")) {
      rewritten.push(await rewriteUriAttribute(line, baseUrl, claims, env, request));
      continue;
    }

    if (line.startsWith("#")) {
      rewritten.push(line);
      continue;
    }

    rewritten.push(await signedRelayUrl(new URL(line, baseUrl).href, claims, env, request));
  }

  return rewritten.join("\n");
}

async function rewriteUriAttribute(line, baseUrl, claims, env, request) {
  const match = line.match(/URI="([^"]+)"/);
  if (!match) return line;
  const signed = await signedRelayUrl(new URL(match[1], baseUrl).href, claims, env, request);
  return line.replace(match[0], `URI="${signed}"`);
}

async function signedRelayUrl(targetUrl, claims, env, request) {
  const payload = JSON.stringify({
    v: 1,
    sid: claims.sid,
    uid: claims.uid,
    url: targetUrl,
    exp: claims.exp,
  });
  const signature = await hmacBase64Url(env.RELAY_TOKEN_SECRET, payload);
  const token = `${base64Url(encoder.encode(payload))}.${signature}`;
  return `${publicBaseUrl(request, env)}/relay/${token}`;
}

async function verifyRelayToken(token, secret) {
  if (!secret) throw new HttpError(503, "Missing RELAY_TOKEN_SECRET");
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) throw new HttpError(400, "Malformed relay token");

  const payload = base64UrlDecode(payloadPart);
  const expected = await hmacBase64Url(secret, payload);
  if (!timingSafeEqual(signaturePart, expected)) {
    throw new HttpError(401, "Invalid relay token signature");
  }

  const claims = JSON.parse(payload);
  if (!claims || claims.v !== 1 || !claims.sid || !claims.uid || !claims.url || !claims.exp) {
    throw new HttpError(400, "Invalid relay token claims");
  }
  const url = new URL(claims.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Unsupported target protocol");
  }
  return claims;
}

async function requireServiceBearer(request, env) {
  const secret = env.EDGE_COORDINATOR_TOKEN || env.RELAY_TOKEN_SECRET;
  if (!secret) throw new HttpError(503, "Missing Edge coordinator secret");
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token || !timingSafeEqual(token, secret)) {
    throw new HttpError(401, "Unauthorized");
  }
}

function assertPublicImageUrl(value, env) {
  const raw = String(value || "").trim();
  if (!raw) throw new HttpError(400, "Missing image url");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Invalid image url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Unsupported image protocol");
  }
  if (isPrivateHostname(url.hostname)) {
    throw new HttpError(403, "Image host is not allowed");
  }
  const allowedHosts = parseCsv(env.IMAGE_PROXY_ALLOWED_HOSTS);
  if (allowedHosts.length && !allowedHosts.some((pattern) => hostMatches(url.hostname, pattern))) {
    throw new HttpError(403, "Image host is not on the allowlist");
  }
  return url;
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

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function imageContentType(value, url) {
  const type = (value || "").split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return type === "image/svg+xml" ? "image/svg+xml; charset=utf-8" : type;
  if (type === "application/octet-stream" || !type) {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
    if (path.endsWith(".png")) return "image/png";
    if (path.endsWith(".webp")) return "image/webp";
    if (path.endsWith(".gif")) return "image/gif";
    if (path.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  }
  return "";
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
  const configured = parseCsv(env.ALLOWED_ORIGINS);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin) || isLocalOrigin(origin))
    ? origin
    : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, range, content-type",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges, x-norva-image-cache, x-norva-image-fallback",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(response, request, env, extraHeaders = {}) {
  const headers = new Headers(response.headers);
  mergeCors(headers, corsHeaders(request, env));
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mergeCors(headers, cors) {
  for (const [name, value] of Object.entries(cors)) {
    headers.set(name, value);
  }
}

function json(request, env, body, status = 200) {
  const safeBody = body === undefined ? {} : body;
  return new Response(JSON.stringify(safeBody), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return parsed;
}

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  if (host.includes(":")) return true;
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return false;
}

function hostMatches(hostname, pattern) {
  const host = String(hostname || "").toLowerCase();
  const rule = String(pattern || "").toLowerCase();
  if (!rule) return false;
  if (rule === "*") return true;
  if (rule.startsWith("*.")) return host.endsWith(rule.slice(1)) || host === rule.slice(2);
  return host === rule;
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringOrNull(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return null;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeExpiresAt(value) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed) && parsed > Date.now()) return new Date(parsed).toISOString();
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function publicBaseUrl(request, env) {
  return trimTrailingSlash(env.PUBLIC_BASE_URL || new URL(request.url).origin);
}

function isConflictingSession(session, next) {
  if (!session || session.ownerKey !== next.ownerKey) return false;
  if (session.sourceKey && next.sourceKey && session.sourceKey !== next.sourceKey) return false;
  if (next.deviceKey && session.deviceKey && next.deviceKey === session.deviceKey) return true;
  return true;
}

function publicSession(session) {
  return {
    id: session.id,
    sourceKey: session.sourceKey,
    deviceKey: session.deviceKey ? "present" : "",
    playbackSessionId: session.playbackSessionId || null,
    gatewaySessionId: session.gatewaySessionId || null,
    itemType: session.itemType || null,
    itemId: session.itemId || null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function publicLock(lock) {
  return {
    id: lock.id,
    sourceKey: lock.sourceKey,
    deviceKey: lock.deviceKey ? "present" : "",
    itemType: lock.itemType || null,
    itemId: lock.itemId || null,
    createdAt: lock.createdAt,
    expiresAt: lock.expiresAt,
  };
}
