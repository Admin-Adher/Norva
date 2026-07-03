import { connect } from "cloudflare:sockets";

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
  "https://norva.tv",
  "https://app.norva.tv",
  "https://norva-web.pages.dev",
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
        return await proxyPlayback(request, env, claims, ctx);
      }

      // Track metadata for the player's audio/subtitle menus. The relay is the
      // only environment that can authenticate against the provider (Deno/Supabase
      // are IP-blocked), so it fetches the Xtream get_vod_info and returns the
      // normalized audio/video stream details. Token-gated (same signed token as
      // /relay/), so only a live playback session can call it.
      if (url.pathname.startsWith("/vod-info/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json(request, env, { error: "Method not allowed" }, 405);
        }
        const token = decodeURIComponent(url.pathname.slice("/vod-info/".length));
        const claims = await verifyRelayToken(token, env.RELAY_TOKEN_SECRET);
        if (claims.exp * 1000 < Date.now()) {
          return json(request, env, { error: "Relay token expired" }, 401);
        }
        return await relayVodInfo(request, env, claims, ctx);
      }

      // Series detail metadata. Same rationale as /vod-info/: the relay is the only
      // egress the provider does NOT user_multi_ip-block for this account (Cloudflare,
      // not the Railway gateway nor the Supabase edge — both datacenter IPs the provider
      // rejects). The signed token's `url` claim is the full get_series_info
      // player_api.php URL; the relay fetches it and returns the JSON verbatim.
      if (url.pathname.startsWith("/series-info/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json(request, env, { error: "Method not allowed" }, 405);
        }
        const token = decodeURIComponent(url.pathname.slice("/series-info/".length));
        const claims = await verifyRelayToken(token, env.RELAY_TOKEN_SECRET);
        if (claims.exp * 1000 < Date.now()) {
          return json(request, env, { error: "Relay token expired" }, 401);
        }
        return await relaySeriesInfo(request, env, claims, ctx);
      }

      // Deep audio-language probe: get_vod_info's DEFAULT track + a container
      // header-probe (MP4 moov / Matroska Tracks) to enumerate EVERY audio track's
      // language — recovers multi-audio files and titles whose default track is
      // "und". Range requests only; token-gated like /relay/ and /vod-info/.
      if (url.pathname.startsWith("/probe-audio/")) {
        if (request.method !== "GET") {
          return json(request, env, { error: "Method not allowed" }, 405);
        }
        const token = decodeURIComponent(url.pathname.slice("/probe-audio/".length));
        const claims = await verifyRelayToken(token, env.RELAY_TOKEN_SECRET);
        if (claims.exp * 1000 < Date.now()) {
          return json(request, env, { error: "Relay token expired" }, 401);
        }
        return await relayProbeAudio(request, env, claims, ctx);
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
    const rawAborted = await this.expireRawPumps(conflicts.filter((session) => session.lane === "raw" && !session.gatewaySessionId));
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

    // A gateway ffmpeg needs the full slot-release window (~8s); an aborted raw
    // pump tears its TCP connection immediately, so a short settle is enough —
    // and no conflict means no wait at all.
    const hadGatewayConflict = conflicts.some((session) => session.gatewaySessionId);
    const waitMs = hadGatewayConflict
      ? boundedInt(this.env.PROVIDER_SLOT_RELEASE_DELAY_MS, 8000, 0, 15_000)
      : conflicts.length ? 1500 : 0;

    return {
      ok: true,
      lockId: lock.id,
      expiredSessions: conflicts.length,
      gatewayExpired,
      rawAborted,
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
      lane: stringOrNull(body.lane),
      createdAt: new Date().toISOString(),
      expiresAt: normalizeExpiresAt(body.expiresAt ?? body.expires_at),
    };

    // Conflicting records used to be dropped SILENTLY here — their gateway ffmpeg
    // or raw pump kept holding the provider slot. Reap them for real.
    const evicted = state.active.filter((active) => {
      if (session.playbackSessionId && active.playbackSessionId === session.playbackSessionId) return false;
      return isConflictingSession(active, session);
    });
    if (evicted.length) {
      await this.expireSessions(evicted.filter((active) => active.gatewaySessionId));
      await this.expireRawPumps(evicted.filter((active) => active.lane === "raw" && !active.gatewaySessionId));
    }
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
    const rawAborted = await this.expireRawPumps(matches.filter((session) => session.lane === "raw" && !session.gatewaySessionId));
    state.active = state.active.filter((session) => !matches.some((match) => match.id === session.id));
    await this.saveState(state);

    return { ok: true, endedSessions: matches.length, gatewayExpired, rawAborted };
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
    const activeAll = Array.isArray(state.active) ? state.active : [];
    const lapsed = activeAll.filter((session) => {
      const expiresAt = Date.parse(session.expiresAt || "");
      return !(Number.isFinite(expiresAt) && expiresAt > now);
    });
    state.active = activeAll.filter((session) => !lapsed.includes(session));
    state.locks = (Array.isArray(state.locks) ? state.locks : []).filter((lock) => {
      const expiresAt = Date.parse(lock.expiresAt || "");
      return Number.isFinite(expiresAt) && expiresAt > now;
    });
    if (lapsed.length) {
      // Zombie reaping: an expired RECORD used to vanish silently while its gateway
      // ffmpeg / raw pump kept pulling provider bytes (and holding the slot).
      await this.expireSessions(lapsed.filter((session) => session.gatewaySessionId));
      await this.expireRawPumps(lapsed.filter((session) => session.lane === "raw" && !session.gatewaySessionId));
    }
    return state;
  }

  async saveState(state) {
    await this.state.storage.put("state", state);
    // Alarm-driven reaping: without traffic, expired records (and the provider
    // slots their sessions hold) would linger until the next request arrives.
    try {
      const now = Date.now();
      const expiries = [...state.active, ...state.locks]
        .map((entry) => Date.parse(entry.expiresAt || ""))
        .filter((ts) => Number.isFinite(ts) && ts > now);
      if (expiries.length) await this.state.storage.setAlarm(Math.min(...expiries) + 1000);
      else await this.state.storage.deleteAlarm();
    } catch (_) { /* alarms unavailable — traffic-driven reaping still applies */ }
  }

  // Fired by the storage alarm set in saveState: loadState reaps whatever lapsed,
  // saveState persists the pruned state and re-arms for the next expiry.
  async alarm() {
    const state = await this.loadState();
    await this.saveState(state);
  }

  // Cross-device raw-pump eviction: ask the gateway to abort the live byte-pipes
  // of these owners (keyed by the sha256 owner hash — the DO never stores raw ids
  // or credentials). Mirrors expireSessions for the raw lane.
  async expireRawPumps(sessions) {
    if (!sessions.length || !this.env.NORVA_MEDIA_GATEWAY_URL || !this.env.NORVA_MEDIA_GATEWAY_TOKEN) return 0;
    const owners = [...new Set(sessions.map((session) => session.ownerKey).filter(Boolean))];
    let aborted = 0;
    await Promise.allSettled(owners.map(async (ownerKey) => {
      const response = await fetch(
        `${trimTrailingSlash(this.env.NORVA_MEDIA_GATEWAY_URL)}/raw-pumps?ownerKey=${encodeURIComponent(ownerKey)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${this.env.NORVA_MEDIA_GATEWAY_TOKEN}` },
        },
      );
      if (response.ok) {
        const body = await response.json().catch(() => ({}));
        aborted += Number(body.aborted) || 0;
      } else {
        console.warn("[norva-session-coordinator] raw-pump eviction refused", response.status);
      }
    }));
    return aborted;
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

async function proxyPlayback(request, env, claims, ctx) {
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
  const streamKey = claims.url;

  // Fast path for streams we've already learned are only reachable over a TCP
  // socket (raw-IP / non-standard-port nodes). Skip BOTH the fetch() that would
  // 403 ("error code: 1003") AND the bounded-range probe — the node honours
  // open-ended ranges natively. This halves the provider round-trips on every
  // range request after the first. Any miss falls cleanly through to the normal
  // path (which also re-learns if the load-balancer moved the title to a node
  // fetch() can reach).
  if (request.method !== "HEAD" && socketHintFresh(streamKey)) {
    if (requestedRange) headers.set("range", requestedRange);
    try {
      const sock = await trySocketPath(targetUrl, request, headers, env);
      if (sock) return sock;
    } catch (_) { /* fall through to the normal path */ }
    clearSocketHint(streamKey);
    headers.delete("range");
  }

  // Normal path: map open-ended seeks to bounded ranges, then fetch().
  const upstreamRange = await boundedUpstreamRange(requestedRange, targetUrl, headers);
  if (upstreamRange) headers.set("range", upstreamRange);
  else if (requestedRange) headers.set("range", requestedRange);

  // Tie the upstream fetch to an AbortController so a client disconnect tears the
  // provider TCP connection down IMMEDIATELY instead of returning it to the keepalive
  // pool — on single-slot providers a lingering connection keeps 458ing the retries.
  const upstreamAbort = new AbortController();
  let upstream = await fetch(targetUrl, {
    method: request.method,
    headers,
    redirect: "follow",
    signal: upstreamAbort.signal,
  });
  let upstreamFinalUrl = upstream.url || targetUrl.toString();

  // Fallback for backend nodes that fetch() can't reach (raw IP / non-standard
  // port → 403 "error code: 1003"): resolve the provider's redirect, then stream
  // the node over a raw TCP socket. On success, remember the stream so its later
  // range requests take the fast path above. Gated to 401/403 so working titles
  // keep the fast fetch() path untouched; any failure falls through to diagnostics.
  if (!upstream.ok && request.method !== "HEAD" && (upstream.status === 401 || upstream.status === 403)) {
    try {
      const sock = await trySocketPath(targetUrl, request, headers, env);
      if (sock) {
        markNeedsSocket(streamKey);
        return sock;
      }
    } catch (e) {
      console.warn(JSON.stringify({ tag: "norva-relay-socket-fallback-error", error: String((e && e.message) || e) }));
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
    maybeAlertUpstreamError(env, ctx, { host: targetUrl.hostname, status: upstream.status, method: request.method, reason, finalUrl: upstreamFinalUrl });
    // Provider slot-busy (458 "max connections"): transient — tell the player HOW
    // LONG to back off (Retry-After spans the ~8s release window) and hand it a
    // structured body it can classify without string-scraping.
    if (upstream.status === 458 || /max connections?|connection limit/i.test(reason)) {
      errHeaders.set("Retry-After", "8");
      errHeaders.set("Content-Type", "application/json");
      const body = request.method === "HEAD" ? null : JSON.stringify({
        error: "provider_slot_busy",
        code: "PROVIDER_BUSY",
        upstreamStatus: upstream.status,
        retryAfterMs: 8000,
        reason: reasonHeader || "max connections",
      });
      return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: errHeaders });
    }
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
    return new Response(abortOnCancel(upstream.body, upstreamAbort), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  const contentLength = Number.parseInt(upstream.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
    return new Response(abortOnCancel(upstream.body, upstreamAbort), {
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

// Wrap an upstream body so a DOWNSTREAM cancel (client closed the tab / the engine
// aborted its fetch) aborts the UPSTREAM connection instead of letting the runtime
// return it to the keepalive pool. On single-slot IPTV providers that lingering
// pooled connection is exactly what keeps the next attempt 458ing.
function abortOnCancel(body, controller) {
  if (!body) return body;
  try {
    const reader = body.getReader();
    return new ReadableStream({
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) { c.close(); return; }
        c.enqueue(value);
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch (_) { /* already done */ }
        try { controller.abort(); } catch (_) { /* already aborted */ }
      },
    });
  } catch (_) {
    return body; // body already consumed/locked — pass through untouched
  }
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

function indexOfDoubleCRLF(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

function parseHttpResponseHead(text) {
  const lines = text.split("\r\n");
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/.exec(lines[0] || "");
  const status = match ? Number(match[1]) : 502;
  const statusText = match ? match[2] : "Bad Gateway";
  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx > 0) {
      try {
        headers.append(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      } catch (_) {
        /* ignore invalid header */
      }
    }
  }
  return { status, statusText, headers };
}

// Fetch a backend node over a raw TCP socket and speak HTTP/1.1 by hand. Used for
// nodes that fetch() can't reach (raw IP / non-standard port → Cloudflare 1003).
// The response body is streamed straight from the socket to the caller, so a
// multi-GB movie never buffers in the Worker. Returns { status, statusText,
// headers, body, isChunked }.
async function fetchNodeViaSocket(node, method, clientRange, ua) {
  const secure = node.protocol === "https:";
  const port = Number(node.port) || (secure ? 443 : 80);
  const socket = connect(
    { hostname: node.hostname, port },
    secure ? { secureTransport: "on", allowHalfOpen: false } : {},
  );
  await Promise.race([
    socket.opened,
    new Promise((_, rej) => setTimeout(() => rej(new Error("node connect timeout")), 8000)),
  ]);

  const hostHeader = port === 80 || port === 443 ? node.hostname : `${node.hostname}:${port}`;
  let req = `${method === "HEAD" ? "HEAD" : "GET"} ${node.pathname}${node.search} HTTP/1.1\r\n`;
  req += `Host: ${hostHeader}\r\n`;
  req += `User-Agent: ${ua}\r\n`;
  req += `Accept: */*\r\n`;
  if (clientRange) req += `Range: ${clientRange}\r\n`;
  req += `Connection: close\r\n\r\n`;
  const writer = socket.writable.getWriter();
  await writer.write(encoder.encode(req));
  try { writer.releaseLock(); } catch (_) { /* keep going */ }

  const reader = socket.readable.getReader();
  let buf = new Uint8Array(0);
  let headerEnd = -1;
  while (headerEnd < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.length) {
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf);
      merged.set(value, buf.length);
      buf = merged;
      headerEnd = indexOfDoubleCRLF(buf);
    }
    if (buf.length > 65536) break;
  }
  if (headerEnd < 0) {
    try { await reader.cancel(); } catch (_) { /* noop */ }
    try { socket.close(); } catch (_) { /* noop */ }
    throw new Error("node socket: no HTTP header terminator");
  }
  const head = parseHttpResponseHead(decoder.decode(buf.slice(0, headerEnd)));
  const leftover = buf.slice(headerEnd + 4);
  const isChunked = (head.headers.get("transfer-encoding") || "").toLowerCase().includes("chunked");

  if (method === "HEAD") {
    try { await reader.cancel(); } catch (_) { /* noop */ }
    try { socket.close(); } catch (_) { /* noop */ }
    return { status: head.status, statusText: head.statusText, headers: head.headers, body: null, isChunked };
  }

  const body = new ReadableStream({
    start(controller) {
      if (leftover.length) controller.enqueue(leftover);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          try { socket.close(); } catch (_) { /* noop */ }
          return;
        }
        if (value && value.length) controller.enqueue(value);
      } catch (e) {
        controller.error(e);
        try { socket.close(); } catch (_) { /* noop */ }
      }
    },
    cancel() {
      try { reader.cancel(); } catch (_) { /* noop */ }
      try { socket.close(); } catch (_) { /* noop */ }
    },
  });

  return { status: head.status, statusText: head.statusText, headers: head.headers, body, isChunked };
}

// Normalize one Xtream get_vod_info stream object (audio) into the player's track
// shape. The provider has already run ffprobe, so language/channels/bitrate are
// present in info.audio.tags / fields.
function normalizeAudioStream(a) {
  const tags = a && typeof a.tags === "object" && a.tags ? a.tags : {};
  const disp = a && typeof a.disposition === "object" && a.disposition ? a.disposition : {};
  return {
    index: Number(a.index) || 0,
    codec: String(a.codec_name || ""),
    profile: String(a.profile || ""),
    channels: Number(a.channels) || 0,
    channelLayout: String(a.channel_layout || ""),
    sampleRate: Number(a.sample_rate) || 0,
    bitRate: Number(a.bit_rate) || 0,
    language: String(tags.language || ""),
    title: String(tags.title || ""),
    default: disp.default === 1 || disp.default === true,
  };
}

// Fetch the provider's get_series_info from the relay and return it verbatim. Same egress
// rationale as relayVodInfo: the Railway gateway and the Supabase edge are datacenter IPs the
// provider user_multi_ip-blocks; the relay (Cloudflare) is the egress it accepts. The signed
// token's `url` claim is already the full get_series_info player_api.php URL (creds included),
// so the relay just fetches it and returns the JSON. No caching here — the Supabase
// cloud_series_info_cache is the durable cache; the relay is only hit on a cache miss.
async function relaySeriesInfo(request, env, claims, _ctx) {
  let api;
  try {
    api = new URL(claims.url);
  } catch {
    return json(request, env, { error: "Invalid relay target" }, 400);
  }
  // Defense-in-depth: only Supabase (holding RELAY_TOKEN_SECRET) can mint tokens, but still
  // refuse anything that isn't a player_api.php metadata call, so a future change to the
  // minting side can never turn this into a general-purpose fetcher / open proxy.
  if (!api.pathname.toLowerCase().endsWith("/player_api.php")) {
    return json(request, env, { error: "Unsupported relay target" }, 400);
  }
  const ua = String(claims.ua || "VLC/3.0.20 LibVLC/3.0.20");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(api, {
      signal: controller.signal,
      headers: { "user-agent": ua, accept: "application/json,text/plain,*/*" },
      redirect: "follow",
    });
    const text = await resp.text();
    if (!resp.ok) {
      return json(request, env, {
        error: "IPTV provider request failed",
        status: resp.status,
        details: sanitizeUpstreamReason(text),
      }, resp.status);
    }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    return json(request, env, payload, 200);
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return json(request, env, { error: "Unable to reach IPTV provider" }, aborted ? 504 : 502);
  } finally {
    clearTimeout(timer);
  }
}

// Fetch the provider's get_vod_info for the stream in the relay token and return
// normalized audio/video stream details for the player's track menus. Best-effort:
// any failure returns an empty (but valid) shape so the player simply shows no
// extra detail. get_vod_info exposes a single audio stream and no subtitle list
// (subtitled VOD here is hard-subbed), so audioTracks has at most one entry.
async function relayVodInfo(request, env, claims, ctx) {
  const empty = { duration: null, video: null, audioTracks: [], subtitles: [] };
  try {
    const su = new URL(claims.url);
    const parts = su.pathname.split("/").filter(Boolean); // [movie, user, pass, id.ext]
    if (parts[0] !== "movie" || !parts[1] || !parts[2] || !parts[3]) {
      return json(request, env, empty, 200);
    }
    const user = parts[1];
    const pass = parts[2];
    const vodId = parts[3].replace(/\.[a-z0-9]+$/i, "");

    // Cache by (provider host, vod id): the codec metadata is a property of the
    // FILE — identical for every user/session — so one fetch serves everyone at
    // this PoP and we drop a provider round-trip on every playback. Edge Cache API
    // (same mechanism as the image proxy); 24h TTL since codec info is static.
    const cacheKey = new Request(
      `https://edge.norva.tv/__vodinfo/${encodeURIComponent(su.host)}/${encodeURIComponent(vodId)}`,
    );
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = await cached.json().catch(() => null);
      if (hit) return json(request, env, hit, 200);
    }

    const api = `${su.protocol}//${su.host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_vod_info&vod_id=${encodeURIComponent(vodId)}`;
    const ua = String(claims.ua || "VLC/3.0.20 LibVLC/3.0.20");
    const resp = await fetch(api, { headers: { "user-agent": ua, accept: "application/json" } });
    if (!resp.ok) return json(request, env, empty, 200);
    const data = await resp.json().catch(() => null);
    const info = data && typeof data.info === "object" && data.info ? data.info : {};
    const a = info.audio && typeof info.audio === "object" ? info.audio : null;
    const v = info.video && typeof info.video === "object" ? info.video : null;
    const out = {
      duration: Number(info.duration_secs) || null,
      video: v
        ? {
            codec: String(v.codec_name || ""),
            width: Number(v.width) || 0,
            height: Number(v.height) || 0,
            profile: String(v.profile || ""),
            pixFmt: String(v.pix_fmt || ""),
          }
        : null,
      audioTracks: a ? [normalizeAudioStream(a)] : [],
      subtitles: [],
    };

    // Cache only real results — never poison the cache with a transient empty/error.
    if (a || v) {
      const cacheResp = new Response(JSON.stringify(out), {
        headers: { "content-type": "application/json", "Cache-Control": "public, max-age=86400" },
      });
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cache.put(cacheKey, cacheResp));
      else await cache.put(cacheKey, cacheResp).catch(() => {});
    }
    return json(request, env, out, 200);
  } catch (_) {
    return json(request, env, empty, 200);
  }
}

// ── Audio-track language header-probe ──────────────────────────────────────────
// Parses just the container header (via Range requests) to list EVERY audio
// track's language — what get_vod_info (single default track) can't do for
// multi-audio files or "und"-default titles. Supports ISO-BMFF (MP4/MOV) and
// Matroska/WebM. Pure helpers (no I/O) so they're unit-testable.

function readU32BE(buf, off) {
  return buf[off] * 0x1000000 + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3];
}

// MP4 mdhd packed language: bit15=pad, then 3×5-bit (each +0x60 => ISO-639-2 char).
function decodeMp4Lang(hi, lo) {
  const packed = (hi << 8) | lo;
  if (!packed || (packed & 0x8000)) return null;
  const s = String.fromCharCode(((packed >> 10) & 0x1f) + 0x60, ((packed >> 5) & 0x1f) + 0x60, (packed & 0x1f) + 0x60);
  return /^[a-z]{3}$/.test(s) ? s : null;
}

// Walk ISO-BMFF boxes in [start,end); visit(type, payloadStart, payloadEnd).
function walkMp4Boxes(buf, start, end, visit) {
  let off = start;
  while (off + 8 <= end) {
    let size = readU32BE(buf, off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let header = 8;
    if (size === 1) {
      size = readU32BE(buf, off + 8) * 0x100000000 + readU32BE(buf, off + 12);
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header) break;
    visit(type, off + header, Math.min(off + size, end));
    off += size;
  }
}

// Returns { isAudio, lang } for one trak (lang may be null even for audio when the
// track's mdhd language is undetermined).
function mp4TrakInfo(buf, start, end) {
  let handler = null;
  let mdhdLang = null;
  let elngLang = null;
  walkMp4Boxes(buf, start, end, (type, ps, pe) => {
    if (type !== "mdia") return;
    walkMp4Boxes(buf, ps, pe, (t, s, e) => {
      if (t === "hdlr" && s + 12 <= e) {
        handler = String.fromCharCode(buf[s + 8], buf[s + 9], buf[s + 10], buf[s + 11]);
      } else if (t === "mdhd") {
        const langOff = buf[s] === 1 ? s + 4 + 28 : s + 4 + 16; // version 1 uses 64-bit dates
        if (langOff + 2 <= e) mdhdLang = decodeMp4Lang(buf[langOff], buf[langOff + 1]);
      } else if (t === "elng" && s + 4 < e) {
        // Extended language tag ('elng'): version+flags (4B) then a null-terminated
        // BCP-47 string ("ja", "fr-FR", "jpn"). Multi-language muxers routinely set
        // mdhd to "und" and put the real language here; ExoPlayer/ffmpeg (and the
        // native mobile player) read it, so the header-probe must too — otherwise the
        // web engine's audio menu falls back to "Audio 1, Audio 2…".
        let str = "";
        for (let i = s + 4; i < e && i < s + 4 + 32 && buf[i] !== 0; i++) str += String.fromCharCode(buf[i]);
        if (str) elngLang = str;
      }
    });
  });
  // Prefer a real 'elng' language over mdhd (which is "und" in these files).
  const lang = normalizeRelayLang(elngLang) || mdhdLang;
  return { handler, lang };
}

// Ordered audio + subtitle tracks with the ABSOLUTE ffmpeg stream index (= trak
// position in moov, which is how ffmpeg numbers MP4 streams) so a -map 0:<index>
// downstream selects the right track. Includes tracks whose language is undetermined.
function parseMp4Tracks(buf, moovStart, moovEnd) {
  const audioTracks = [];
  const subtitleTracks = [];
  let streamIndex = -1; // every trak (video/audio/sub) consumes one ffmpeg stream slot
  walkMp4Boxes(buf, moovStart, moovEnd, (type, ps, pe) => {
    if (type !== "trak") return;
    streamIndex++;
    const info = mp4TrakInfo(buf, ps, pe);
    if (info.handler === "soun") {
      audioTracks.push({ index: streamIndex, lang: info.lang });
    } else if (info.handler === "subt" || info.handler === "sbtl" || info.handler === "text" || info.handler === "clcp") {
      // ISO-BMFF timed text (tx3g / mov_text): text, WebVTT-convertible.
      subtitleTracks.push({ index: streamIndex, lang: info.lang || null, codec: "mov_text", subtitleType: "text", extractable: true });
    }
  });
  return { audioTracks, subtitleTracks };
}

// Locate the moov box. Walks from the front; if absent (moov-at-end files), scans
// for the signature (the tail buffer doesn't begin on a box boundary).
function findMoov(buf, len) {
  let found = null;
  walkMp4Boxes(buf, 0, len, (type, ps, pe) => { if (type === "moov" && !found) found = { start: ps, end: pe }; });
  if (found) return found;
  for (let i = len - 8; i >= 4; i--) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x6f && buf[i + 2] === 0x6f && buf[i + 3] === 0x76) {
      const size = readU32BE(buf, i - 4);
      if (size >= 8) return { start: i + 4, end: Math.min(i - 4 + size, len) };
    }
  }
  return null;
}

// EBML variable-length integer. keepMarker=true for element IDs (which include the
// length-descriptor bits), false for sizes (which mask them off).
function readVint(buf, off, end, keepMarker) {
  if (off >= end || buf[off] === 0) return null;
  const first = buf[off];
  let mask = 0x80, length = 1;
  while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
  if (length > 8 || off + length > end) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + buf[off + i];
  return { value, length };
}

function walkEbml(buf, start, end, visit) {
  let off = start;
  while (off < end) {
    const id = readVint(buf, off, end, true);
    if (!id) break;
    const size = readVint(buf, off + id.length, end, false);
    if (!size) break;
    const dataStart = off + id.length + size.length;
    const remaining = end - dataStart;
    if (remaining < 0) break;
    const dataLen = size.value > remaining ? remaining : size.value; // clamp unknown/huge sizes
    visit(id.value, dataStart, dataStart + dataLen);
    off = dataStart + dataLen;
  }
}

function ebmlAscii(buf, start, end) {
  let s = "";
  for (let i = start; i < end && i < start + 16; i++) {
    if (buf[i] === 0) break;
    s += String.fromCharCode(buf[i]);
  }
  return s.toLowerCase();
}

// Ordered audio + subtitle tracks with the ABSOLUTE ffmpeg stream index (=
// TrackEntry position, which is how ffmpeg numbers Matroska streams).
function parseMkvTracks(buf, len) {
  const audioTracks = [];
  const subtitleTracks = [];
  let streamIndex = -1; // every TrackEntry (video/audio/sub) is one ffmpeg stream slot
  walkEbml(buf, 0, len, (id, ds, de) => {
    if (id !== 0x18538067) return; // Segment
    walkEbml(buf, ds, de, (id2, s2, e2) => {
      if (id2 !== 0x1654ae6b) return; // Tracks
      walkEbml(buf, s2, e2, (id3, s3, e3) => {
        if (id3 !== 0xae) return; // TrackEntry
        streamIndex++;
        let trackType = null, language = null, bcp47 = null, codecId = null, flagForced = 0;
        walkEbml(buf, s3, e3, (id4, s4, e4) => {
          if (id4 === 0x83) trackType = buf[s4]; // TrackType (2=audio, 17=subtitle)
          else if (id4 === 0x22b59c) language = ebmlAscii(buf, s4, e4); // Language (ISO-639-2)
          else if (id4 === 0x22b59d) bcp47 = ebmlAscii(buf, s4, e4); // LanguageBCP47
          else if (id4 === 0x86) codecId = ebmlAscii(buf, s4, e4); // CodecID (e.g. s_text/ass)
          else if (id4 === 0x55aa && s4 < e4) flagForced = buf[s4]; // FlagForced
        });
        if (trackType === 2) {
          audioTracks.push({ index: streamIndex, lang: bcp47 || language || "eng" }); // audio; MKV default 'eng'
        } else if (trackType === 17) {
          const sub = mkvSubtitleCodec(codecId); // { name, image }
          subtitleTracks.push({
            index: streamIndex,
            lang: bcp47 || language || null, // subtitles have no sensible default language
            codec: sub.name,
            subtitleType: sub.image ? "image" : "text",
            extractable: !sub.image,
            forced: flagForced === 1,
          });
        }
      });
    });
  });
  return { audioTracks, subtitleTracks };
}

// Matroska CodecID -> ffmpeg codec name + whether it's image-based. PGS/VobSub
// can't convert to WebVTT (image); text codecs can. CodecID is lowercased by
// ebmlAscii: "s_text/ass", "s_text/utf8", "s_hdmv/pgs", "s_vobsub", …
function mkvSubtitleCodec(codecId) {
  const id = String(codecId || "");
  if (id.includes("ass")) return { name: "ass", image: false };
  if (id.includes("ssa")) return { name: "ssa", image: false };
  if (id.includes("webvtt")) return { name: "webvtt", image: false };
  if (id.includes("utf8") || id.includes("s_text")) return { name: "subrip", image: false };
  if (id.includes("pgs") || id.includes("hdmv")) return { name: "hdmv_pgs_subtitle", image: true };
  if (id.includes("vobsub")) return { name: "dvd_subtitle", image: true };
  if (id.includes("dvb")) return { name: "dvb_subtitle", image: true };
  return { name: "subrip", image: false }; // unknown -> assume extractable text
}

function normalizeRelayLang(value) {
  // Reduce a BCP-47 / IETF tag to its primary language subtag before matching:
  // Matroska LanguageIETF (and some muxers) write "fr-FR", "pt-BR", "zh-Hans",
  // etc. The old `.slice(0, 3)` turned "fr-FR" into "fr-" (length 3, not in the
  // map) → null, dropping the language for every track in such files. Split on
  // the subtag separator first so "fr-FR" → "fr".
  const primary = String(value || "").toLowerCase().trim().split(/[-_]/)[0];
  const v = primary.slice(0, 3);
  if (!v || v === "und" || v === "mis" || v === "zxx" || v === "mul") return null;
  const map = {
    fre: "fr", fra: "fr", eng: "en", ger: "de", deu: "de", spa: "es", ita: "it",
    por: "pt", dut: "nl", nld: "nl", ara: "ar", rus: "ru", tur: "tr", pol: "pl",
    hin: "hi", jpn: "ja", kor: "ko", zho: "zh", chi: "zh",
  };
  const code = map[v] || (v.length === 2 ? v : null);
  return code && /^[a-z]{2}$/.test(code) ? code : null;
}

function normalizeRelayLangs(list) {
  const out = new Set();
  for (const l of list) {
    const code = normalizeRelayLang(l);
    if (code) out.add(code);
  }
  return [...out];
}

// Keep audio tracks IN ORDER with their absolute stream index; normalize the
// language (null when undetermined). Order/index are preserved (unlike the deduped
// language set) so the player can build a switchable per-track menu.
function normalizeRelayTracks(list) {
  return (Array.isArray(list) ? list : []).map((t) => ({
    index: Number.isInteger(t.index) ? t.index : null,
    lang: normalizeRelayLang(t.lang),
  }));
}

function parseTotalFromContentRange(value) {
  const m = /\/(\d+)\s*$/.exec(String(value || ""));
  return m ? Number(m[1]) : null;
}

async function readStreamUpTo(body, maxBytes) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
  } catch (_) { /* partial buffer is fine */ }
  try { await reader.cancel(); } catch (_) { /* noop */ }
  const out = new Uint8Array(Math.min(received, maxBytes));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}

// Fetch a byte range, falling back to the raw-TCP-socket path for IP-brute nodes.
async function probeRange(targetUrl, ua, start, endInclusive, maxBytes) {
  const range = `bytes=${start}-${endInclusive}`;
  const headers = new Headers({ "user-agent": ua, range, accept: "*/*" });
  let resp = null;
  try { resp = await fetch(targetUrl, { method: "GET", headers, redirect: "follow" }); } catch (_) { resp = null; }
  if (!resp || (!resp.ok && resp.status !== 206)) {
    try {
      const manual = await fetch(targetUrl, { method: "GET", headers, redirect: "manual" });
      const loc = manual.status >= 300 && manual.status < 400 ? manual.headers.get("location") : null;
      if (!loc) return null;
      const nodeResp = await fetchNodeViaSocket(new URL(loc, targetUrl), "GET", range, ua);
      if (!(nodeResp.status >= 200 && nodeResp.status < 400) || nodeResp.isChunked) return null;
      const total = parseTotalFromContentRange(nodeResp.headers.get("content-range")) || Number(nodeResp.headers.get("content-length")) || null;
      return { bytes: await readStreamUpTo(nodeResp.body, maxBytes), total };
    } catch (_) { return null; }
  }
  const total = parseTotalFromContentRange(resp.headers.get("content-range")) || Number(resp.headers.get("content-length")) || null;
  return { bytes: await readStreamUpTo(resp.body, maxBytes), total };
}

// Top-level moov box location (absolute file offset + size), or null.
function locateMoov(buf, len) {
  let off = 0;
  while (off + 8 <= len) {
    let size = readU32BE(buf, off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let header = 8;
    if (size === 1) { size = readU32BE(buf, off + 8) * 0x100000000 + readU32BE(buf, off + 12); header = 16; }
    else if (size === 0) { size = len - off; }
    if (size < header) break;
    if (type === "moov") return { offset: off, size };
    off += size;
  }
  return null;
}

async function probeContainerTracks(targetUrl, ua) {
  const EMPTY = { audioTracks: [], subtitleTracks: [] };
  // 256 KB head: enough for ftyp + the moov box header (faststart) or EBML/Tracks.
  const head = await probeRange(targetUrl, ua, 0, 262143, 262144);
  if (!head?.bytes || head.bytes.length < 16) return EMPTY;
  const buf = head.bytes;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    let parsed = parseMkvTracks(buf, buf.length);
    if (!parsed.audioTracks.length && head.total && head.total > buf.length) {
      const more = await probeRange(targetUrl, ua, 0, 1048575, 1048576); // 1 MB
      if (more?.bytes) parsed = parseMkvTracks(more.bytes, more.bytes.length);
    }
    return normalizeRelayContainerTracks(parsed);
  }
  // ISO-BMFF: locate the moov (faststart header is in `head`; else scan the tail),
  // then fetch its FULL extent so every track's language box is buffered (a later
  // track's mdhd sits after earlier tracks' bulky sample tables).
  const located = locateMoov(buf, buf.length);
  let moovOffset = located ? located.offset : -1;
  let moovSize = located ? located.size : 0;
  if (moovOffset < 0 && head.total) {
    const TAIL = 4 * 1024 * 1024;
    const ts = Math.max(0, head.total - TAIL);
    const tail = await probeRange(targetUrl, ua, ts, head.total - 1, TAIL);
    const tb = tail?.bytes;
    if (tb) {
      for (let i = tb.length - 8; i >= 4; i--) {
        if (tb[i] === 0x6d && tb[i + 1] === 0x6f && tb[i + 2] === 0x6f && tb[i + 3] === 0x76) {
          const size = readU32BE(tb, i - 4);
          if (size >= 8) { moovOffset = ts + i - 4; moovSize = size; break; }
        }
      }
    }
  }
  if (moovOffset < 0) return EMPTY;
  const cap = Math.min(moovSize || 16 * 1024 * 1024, 16 * 1024 * 1024);
  const full = await probeRange(targetUrl, ua, moovOffset, moovOffset + cap - 1, cap);
  if (!full?.bytes || full.bytes.length < 16) return EMPTY;
  const moov = findMoov(full.bytes, full.bytes.length); // moov now begins this buffer
  return moov ? normalizeRelayContainerTracks(parseMp4Tracks(full.bytes, moov.start, moov.end)) : EMPTY;
}

// Normalize a {audioTracks, subtitleTracks} bundle: audio langs via the shared
// helper; subtitles keep their codec/type/extractable flags with a normalized lang.
function normalizeRelayContainerTracks(parsed) {
  return {
    audioTracks: normalizeRelayTracks(parsed.audioTracks),
    subtitleTracks: (Array.isArray(parsed.subtitleTracks) ? parsed.subtitleTracks : [])
      .map((t) => ({
        index: Number.isInteger(t.index) ? t.index : null,
        lang: normalizeRelayLang(t.lang),
        codec: t.codec || null,
        subtitleType: t.subtitleType || (t.extractable ? "text" : "image"),
        extractable: t.extractable === true,
        forced: t.forced === true,
      }))
      .filter((t) => t.index !== null),
  };
}

async function relayProbeAudio(request, env, claims, ctx) {
  // Same shape every track sees for a given file, so cache by (host, vod id) — the
  // codec/track layout is a property of the FILE. 24h edge cache (like /vod-info)
  // so opening the audio menu repeatedly doesn't re-probe the provider.
  let cacheKey = null;
  const cache = caches.default;
  try {
    const su0 = new URL(claims.url);
    const p0 = su0.pathname.split("/").filter(Boolean);
    const vid0 = p0[3] ? p0[3].replace(/\.[a-z0-9]+$/i, "") : p0[3];
    // The /vN segment is a cache-version bump: it bypasses entries cached before a
    // probe-shape change. v2 = the 'elng' language fix; v3 = subtitle tracks added
    // to the response (so audio-only entries cached pre-subtitle don't stick 24h).
    cacheKey = new Request(`https://edge.norva.tv/__probeaudio/v3/${encodeURIComponent(su0.host)}/${encodeURIComponent(vid0 || su0.pathname)}`);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hit = await cached.json().catch(() => null);
      if (hit) return json(request, env, hit, 200);
    }
  } catch (_) { cacheKey = null; }

  const out = { audioLanguages: [], audioTracks: [], audioDefaultLanguage: null, subtitles: [] };
  try {
    const su = new URL(claims.url);
    const ua = String(claims.ua || "VLC/3.0.20 LibVLC/3.0.20");
    const langs = new Set();
    let defaultLang = null;
    // get_vod_info default track (cheap baseline; movie URLs only).
    const parts = su.pathname.split("/").filter(Boolean);
    if (parts[0] === "movie" && parts[1] && parts[2] && parts[3]) {
      const vodId = parts[3].replace(/\.[a-z0-9]+$/i, "");
      const api = `${su.protocol}//${su.host}/player_api.php?username=${encodeURIComponent(parts[1])}&password=${encodeURIComponent(parts[2])}&action=get_vod_info&vod_id=${encodeURIComponent(vodId)}`;
      try {
        const r = await fetch(api, { headers: { "user-agent": ua, accept: "application/json" } });
        if (r.ok) {
          const d = await r.json().catch(() => null);
          const code = normalizeRelayLang(d?.info?.audio?.tags?.language);
          if (code) { langs.add(code); defaultLang = code; }
        }
      } catch (_) { /* baseline is best-effort */ }
    }
    // Header-probe ALL tracks (ordered, with the absolute ffmpeg stream index).
    // One pass yields both audio AND subtitle tracks (the container header carries
    // both), so the engine path gets subtitles with zero extra provider round-trips.
    let container = { audioTracks: [], subtitleTracks: [] };
    try { container = await probeContainerTracks(claims.url, ua); } catch (_) { /* best-effort */ }
    const tracks = container.audioTracks;
    for (const t of tracks) { if (t.lang) langs.add(t.lang); }
    out.audioTracks = tracks;
    out.subtitles = container.subtitleTracks;
    out.audioDefaultLanguage = defaultLang;
    out.audioLanguages = [...langs];
  } catch (_) { /* never throw */ }

  // Cache ONLY a successful container probe (audioTracks non-empty). An empty
  // audioTracks means the header-probe failed — every video file has >=1 audio
  // track, so [] is never a real layout. get_vod_info's single default language
  // can populate audioLanguages even when the probe fails; caching on that alone
  // (the old `|| audioLanguages.length`) poisoned the 24h window with an empty
  // track list, so the engine-path audio menu fell back to "Audio 1, Audio 2…"
  // instead of real per-track language names. A miss re-probes next time (cheap
  // at this scale; the precompute path handles provider load when it matters).
  if (cacheKey && out.audioTracks.length) {
    try {
      const body = JSON.stringify(out);
      ctx.waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "max-age=86400" },
      })));
    } catch (_) { /* cache is best-effort */ }
  }
  return json(request, env, out, 200);
}

// In-isolate hint: once a stream is confirmed reachable only via the TCP socket
// path, remember it so its later range requests skip the fetch() that 403s and the
// bounded-range probe. Lost on a cold isolate (worst case: one extra 403 to
// re-learn). Bounded LRU, keyed by the stream URL so it's shared across a title's
// many range requests (and across users on the same provider account).
const SOCKET_HINTS = new Map();
const SOCKET_HINT_TTL_MS = 5 * 60 * 1000;
const SOCKET_HINT_MAX = 512;

function markNeedsSocket(key) {
  if (!key) return;
  if (SOCKET_HINTS.size >= SOCKET_HINT_MAX) {
    const oldest = SOCKET_HINTS.keys().next().value;
    if (oldest !== undefined) SOCKET_HINTS.delete(oldest);
  }
  SOCKET_HINTS.set(key, Date.now());
}

function socketHintFresh(key) {
  const at = key ? SOCKET_HINTS.get(key) : undefined;
  return at !== undefined && Date.now() - at < SOCKET_HINT_TTL_MS;
}

function clearSocketHint(key) {
  if (key) SOCKET_HINTS.delete(key);
}

// Optional per-provider alerting (docs/roadmap/scaling-status.md §B). When MONITOR_WEBHOOK
// is set, POST a compact alert on upstream errors, sampled to at most once per
// (host,status) per 5 min so a flapping provider can't flood. Off by default (no secret
// => no-op). Fire-and-forget via ctx.waitUntil so it never adds latency to the player's
// error path. The structured console.warn log is emitted regardless.
const ALERT_SENT = new Map();
const ALERT_TTL_MS = 5 * 60 * 1000;
const ALERT_MAX = 512;

function maybeAlertUpstreamError(env, ctx, info) {
  const webhook = env && env.MONITOR_WEBHOOK;
  if (!webhook) return;
  const key = `${info.host}|${info.status}`;
  const at = ALERT_SENT.get(key);
  if (at !== undefined && Date.now() - at < ALERT_TTL_MS) return;
  if (ALERT_SENT.size >= ALERT_MAX) {
    const oldest = ALERT_SENT.keys().next().value;
    if (oldest !== undefined) ALERT_SENT.delete(oldest);
  }
  ALERT_SENT.set(key, Date.now());
  const body = JSON.stringify({
    tag: "norva-relay-upstream-error",
    host: info.host,
    status: info.status,
    method: info.method,
    reason: String(info.reason || "").slice(0, 200),
    finalUrl: String(info.finalUrl || "").slice(0, 300),
  });
  const send = fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(send);
}

// Resolve the provider's redirect (auth) and stream the resulting node over a raw
// TCP socket. Returns a streaming Response on success, or null when there's no
// redirect / the node didn't serve a usable response (caller falls back).
async function trySocketPath(targetUrl, request, headers, env) {
  const resolved = await fetch(targetUrl, { method: "GET", headers, redirect: "manual" });
  const loc = resolved.status >= 300 && resolved.status < 400 ? resolved.headers.get("location") : null;
  if (!loc) return null;
  const node = new URL(loc, targetUrl);
  const ua = headers.get("user-agent") || "VLC/3.0.20 LibVLC/3.0.20";
  const nodeResp = await fetchNodeViaSocket(node, request.method, headers.get("range"), ua);
  if (!(nodeResp.status >= 200 && nodeResp.status < 400) || nodeResp.isChunked) return null;
  const sockHeaders = new Headers();
  for (const [k, v] of nodeResp.headers) {
    const lk = k.toLowerCase();
    if (
      lk === "content-type" || lk === "content-length" || lk === "content-range" ||
      lk === "accept-ranges" || lk === "etag" || lk === "last-modified"
    ) {
      sockHeaders.set(k, v);
    }
  }
  mergeCors(sockHeaders, corsHeaders(request, env));
  if (!sockHeaders.has("Accept-Ranges")) sockHeaders.set("Accept-Ranges", "bytes");
  sockHeaders.set("Cache-Control", "private, max-age=30");
  sockHeaders.set("X-Norva-Relay-Path", "socket");
  return new Response(request.method === "HEAD" ? null : nodeResp.body, {
    status: nodeResp.status,
    statusText: nodeResp.statusText,
    headers: sockHeaders,
  });
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
    "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges, retry-after, x-norva-image-cache, x-norva-image-fallback, x-norva-upstream-status, x-norva-upstream-reason, x-norva-upstream-final",
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
