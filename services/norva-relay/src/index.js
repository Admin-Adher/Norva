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

// When an upstream image is dead, the proxy redirects here: the single validated,
// high-quality branded Norva poster served by the site. Using one canonical asset
// (instead of an inline SVG) keeps the fallback identical everywhere — and because
// it's a real file, an <img> shows it whether or not the page wires an onerror.
const BRANDED_PLACEHOLDER_URL = "https://norva.tv/img/norva-media-placeholder.png";

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
      ? boundedInt(this.env.PROVIDER_SLOT_RELEASE_DELAY_MS, 8000, 0, 15_000)
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
  // IPTV providers gate on User-Agent: a browser UA is rejected (403). Use the
  // source's configured UA carried in the signed relay token (the same UA the
  // gateway uses successfully); never forward the caller's browser UA. Fall
  // back to a VLC UA when the token has none.
  headers.set("user-agent", String(claims.ua || "VLC/3.0.20 LibVLC/3.0.20"));

  // Resume seeks: the IPTV provider ignores OPEN-ENDED Range requests
  // (`bytes=N-` is answered from byte 0), so a player seek re-reads the file
  // from the start — the ~20s Resume stall. It DOES honor BOUNDED ranges
  // (`bytes=N-M`). Map an open-ended seek (N>0) to a bounded range using the
  // file's total size so the player jumps straight to the resume point.
  // `bytes=0-` is left untouched (answering from byte 0 is already correct),
  // which keeps cold startup fast.
  const requestedRange = request.headers.get("range");
  const upstreamRange = await boundedUpstreamRange(requestedRange, targetUrl, headers);
  if (upstreamRange) headers.set("range", upstreamRange);
  else if (requestedRange) headers.set("range", requestedRange);

  let upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    redirect: "follow",
  });
  let upstreamFinalUrl = upstream.url || targetUrl.toString();

  // Some IPTV providers 302 VOD playback to a backend node addressed by a raw IP
  // that itself sits behind Cloudflare, which then refuses the IP-host request
  // with HTTP 403 "error code: 1003" (Direct IP Access Not Allowed). When the
  // straight follow is rejected, re-follow the redirect chain manually, re-pointing
  // any IP-host hop back to the provider's domain (same path/query) so Cloudflare
  // can route it. Gated to 401/403 so working titles keep the fast path untouched.
  if (!upstream.ok && request.method !== "HEAD" && (upstream.status === 401 || upstream.status === 403)) {
    try {
      const recovered = await refetchRewritingIpRedirects(targetUrl, request.method, headers);
      if (recovered?.response) {
        upstream = recovered.response;
        upstreamFinalUrl = recovered.finalUrl || upstreamFinalUrl;
      }
    } catch (_) {
      // best-effort recovery; fall back to the original upstream response
    }
  }
  rememberContentLength(targetUrl, upstream);

  // Diagnostics: when the provider rejects the stream (401/403/404/5xx) the
  // <video> element only ever surfaces a generic "error 4", hiding whether the
  // cause is a connection limit, a wrong container, or a dead link. Short-circuit
  // non-OK responses with the real upstream status + a sanitized reason — exposed
  // as headers (CORS-readable by the player) and logged to the Worker tail. The
  // status the player sees is unchanged, so playback/fallback behaviour is
  // identical; this only adds observability.
  if (!upstream.ok) {
    const errHeaders = filteredResponseHeaders(upstream.headers);
    mergeCors(errHeaders, corsHeaders(request, env));
    errHeaders.set("Cache-Control", "no-store");
    errHeaders.set("X-Norva-Upstream-Status", String(upstream.status));
    errHeaders.set("X-Norva-Upstream-Final", String(upstreamFinalUrl || "").replace(/[^\x20-\x7E]/g, "").slice(0, 300));
    const reason = request.method === "HEAD"
      ? ""
      : sanitizeUpstreamReason(await upstream.text().catch(() => ""));
    const reasonHeader = reason.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 200);
    if (reasonHeader) errHeaders.set("X-Norva-Upstream-Reason", reasonHeader);
    console.warn(JSON.stringify({
      tag: "norva-relay-upstream-error",
      method: request.method,
      status: upstream.status,
      statusText: upstream.statusText,
      host: targetUrl.hostname,
      path: targetUrl.pathname,
      finalUrl: upstreamFinalUrl,
      reason: reason.slice(0, 200),
    }));
    return new Response(request.method === "HEAD" ? null : reason, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: errHeaders,
    });
  }

  const responseHeaders = filteredResponseHeaders(upstream.headers);
  mergeCors(responseHeaders, corsHeaders(request, env));
  responseHeaders.set("Cache-Control", "private, max-age=30");

  if (request.method === "HEAD" || !isHlsPlaylist(targetUrl, upstream.headers)) {
    // Advertise range support so the player enables client-side seeking.
    if (!responseHeaders.has("Accept-Ranges")) responseHeaders.set("Accept-Ranges", "bytes");
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

// --- Bounded-range seeking -------------------------------------------------
// Cache each source's total size (learned from a response) so a seek can issue
// a BOUNDED upstream range without an extra probe round-trip. Isolate-local;
// worst case a cold isolate does one tiny probe per source.
const CONTENT_LENGTH_CACHE = new Map();
const CONTENT_LENGTH_TTL_MS = 5 * 60 * 1000;
const CONTENT_LENGTH_CACHE_MAX = 256;

function cacheContentLength(href, total) {
  if (CONTENT_LENGTH_CACHE.size >= CONTENT_LENGTH_CACHE_MAX) {
    const oldest = CONTENT_LENGTH_CACHE.keys().next().value;
    if (oldest !== undefined) CONTENT_LENGTH_CACHE.delete(oldest);
  }
  CONTENT_LENGTH_CACHE.set(href, { total, at: Date.now() });
}

function totalSizeFromResponse(response) {
  const contentRange = response.headers.get("content-range"); // "bytes 0-0/12345678"
  if (contentRange) {
    const match = /\/(\d+)\s*$/.exec(contentRange);
    if (match) {
      const total = Number.parseInt(match[1], 10);
      if (Number.isFinite(total) && total > 0) return total;
    }
  }
  if (response.status === 200) {
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > 0) return contentLength;
  }
  return NaN;
}

function rememberContentLength(targetUrl, response) {
  const total = totalSizeFromResponse(response);
  if (Number.isFinite(total)) cacheContentLength(targetUrl.href, total);
}

async function resolveContentLength(targetUrl, baseHeaders) {
  const cached = CONTENT_LENGTH_CACHE.get(targetUrl.href);
  if (cached && Date.now() - cached.at < CONTENT_LENGTH_TTL_MS) return cached.total;
  // Probe with a tiny BOUNDED range (which the provider honors) and read the
  // total size from Content-Range, then reuse it for every seek on this URL.
  try {
    const probeHeaders = new Headers(baseHeaders);
    probeHeaders.set("range", "bytes=0-0");
    const probe = await fetch(targetUrl, { method: "GET", headers: probeHeaders, redirect: "follow" });
    const total = totalSizeFromResponse(probe);
    try { await probe.body?.cancel?.(); } catch (_) { /* ignore */ }
    if (Number.isFinite(total)) {
      cacheContentLength(targetUrl.href, total);
      return total;
    }
  } catch (_) { /* fall back to the original range */ }
  return NaN;
}

async function boundedUpstreamRange(rangeHeader, targetUrl, baseHeaders) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;                 // suffix or multi-range: leave to upstream
  if (match[2]) return null;               // already bounded
  const start = Number.parseInt(match[1], 10);
  if (!Number.isFinite(start) || start === 0) return null; // from byte 0 is already correct
  const total = await resolveContentLength(targetUrl, baseHeaders);
  if (!Number.isFinite(total) || start >= total) return null;
  return `bytes=${start}-${total - 1}`;
}

async function proxyImage(request, env, ctx, url) {
  const target = assertPublicImageUrl(url.searchParams.get("url") ?? "", env);
  const cacheKey = new Request(`${url.origin}/image?url=${encodeURIComponent(target.href)}`, request);
  const cache = caches.default;
  // TMDB image paths are content-immutable (a /t/p/<size><path> URL never changes
  // bytes), so they can be cached effectively forever — meaning image.tmdb.org is
  // hit once per asset, ever. Provider images can change, so they stay at a day.
  const longCache = /(^|\.)image\.tmdb\.org$/i.test(target.hostname);

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
      cacheTtl: longCache ? 31536000 : 86400,
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
  headers.set("Cache-Control", longCache
    ? "public, max-age=31536000, immutable"
    : "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400");
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
  // Redirect (don't inline a body) to the branded placeholder so every dead image
  // resolves to the exact same validated Norva poster. A 302 keeps it temporary —
  // if the upstream recovers, the next request proxies the real poster again.
  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(request, env),
      Location: BRANDED_PLACEHOLDER_URL,
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
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

// Provider error pages (returned with a 401/403/404/5xx) carry the real reason
// — "Connection limit reached", "Forbidden", "Not found". Strip HTML/whitespace
// to a short, loggable, header-safe snippet.
function sanitizeUpstreamReason(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function isIpHost(hostname) {
  if (!hostname) return false;
  if (hostname.startsWith("[")) return true;          // IPv6 literal, e.g. [2606:...]
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);   // IPv4
}

// Re-fetch following redirects manually, re-pointing any redirect hop whose host
// is a raw IP back to the provider's domain (preserving path + query). IPTV
// providers commonly 302 VOD to an IP-addressed backend node; when that node is
// behind Cloudflare it answers IP-host requests with 403 "error code: 1003"
// (Direct IP Access Not Allowed). Routing the same path via the domain lets
// Cloudflare resolve it. Returns the final response + the URL actually fetched.
async function refetchRewritingIpRedirects(startUrl, method, headers, maxHops = 5) {
  let url = new URL(startUrl.toString());
  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await fetch(url, { method, headers, redirect: "manual" });
    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
    if (!location) return { response: resp, finalUrl: url.toString() };
    let next;
    try {
      next = new URL(location, url);
    } catch (_) {
      return { response: resp, finalUrl: url.toString() };
    }
    if (isIpHost(next.hostname) && !isIpHost(startUrl.hostname)) {
      // Swap the raw IP for the provider's hostname but KEEP the node's port,
      // path and token. These backend nodes are Cloudflare-fronted (Spectrum) on
      // a non-standard port and reject IP-host access with 403 "error code: 1003"
      // (Direct IP Access Not Allowed) while accepting the same request by
      // hostname. (Dropping the port instead just bounces back to the redirect.)
      next.hostname = startUrl.hostname;
    }
    url = next;
  }
  const resp = await fetch(url, { method, headers, redirect: "follow" });
  return { response: resp, finalUrl: resp.url || url.toString() };
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const configured = parseCsv(env.ALLOWED_ORIGINS);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin) || isLocalOrigin(origin) || isNorvaOrigin(origin))
    ? origin
    : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, range, content-type",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges, x-norva-image-cache, x-norva-image-fallback, x-norva-upstream-status, x-norva-upstream-reason, x-norva-upstream-final",
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

// The production site (norva.tv and any subdomain) is always allowed. The
// in-browser engine fetches relay byte-ranges with fetch(), which — unlike
// <video src> — strictly enforces CORS, so this must hold regardless of the
// worker's ALLOWED_ORIGINS env configuration.
function isNorvaOrigin(origin) {
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === "https:" && (hostname === "norva.tv" || hostname.endsWith(".norva.tv"));
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
