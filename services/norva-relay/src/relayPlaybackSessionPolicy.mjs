const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COORDINATOR_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SEALED_COORDINATOR_ROUTE_PATTERN = /^[A-Za-z0-9_-]{95}$/;

export function isRelayCoordinatorKey(value) {
  return COORDINATOR_KEY_PATTERN.test(stringValue(value));
}

export function classifyRelaySessionClaims(claims) {
  if (!claims || typeof claims !== "object") return { kind: "invalid" };
  const sid = stringValue(claims.sid);

  // Tokens minted before the revocation protocol carried a real playback UUID
  // but no coordinator key. They must fail closed after rollout; otherwise an
  // already-issued browser URL could outlive a cross-device takeover.
  if (claims.v === 1) {
    if (!sid || !stringValue(claims.uid)) return { kind: "invalid" };
    return UUID_PATTERN.test(sid)
      ? { kind: "legacy_playback", sid }
      : { kind: "service", sid };
  }

  const coord = stringValue(claims.coord);
  const route = stringValue(claims.route);
  if (
    claims.v !== 2
    || claims.purpose !== "playback"
    || !UUID_PATTERN.test(sid)
  ) {
    return { kind: "invalid" };
  }

  if (!coord && SEALED_COORDINATOR_ROUTE_PATTERN.test(route)) {
    return { kind: "sealed_playback", sid, route };
  }
  if (!isRelayCoordinatorKey(coord)) return { kind: "invalid" };

  return { kind: "playback", sid, coord };
}

export function relayPlaybackSessionIsActive(activeSessions, claims, now = Date.now()) {
  const disposition = classifyRelaySessionClaims(claims);
  if (disposition.kind !== "playback" || !Array.isArray(activeSessions)) return false;

  return activeSessions.some((session) => {
    if (!session || typeof session !== "object") return false;
    const expiresAt = Date.parse(String(session.expiresAt || ""));
    return session.playbackSessionId === disposition.sid
      && session.coord === disposition.coord
      && session.lane === "relay"
      && Number.isFinite(expiresAt)
      && expiresAt > now;
  });
}

export function classifyRelayPlaybackGeneration(current, next) {
  const currentId = stringValue(current?.playbackSessionId);
  const nextId = stringValue(next?.playbackSessionId);
  if (currentId && currentId === nextId) return "same";
  const currentSuperseded = Array.isArray(current?.supersededPlaybackSessionIds)
    ? current.supersededPlaybackSessionIds.map(stringValue)
    : [];
  const nextSuperseded = Array.isArray(next?.supersededPlaybackSessionIds)
    ? next.supersededPlaybackSessionIds.map(stringValue)
    : [];
  if (currentId && nextSuperseded.includes(currentId)) return "current_older";
  if (nextId && currentSuperseded.includes(nextId)) return "current_newer";

  const currentAt = Date.parse(String(current?.playbackCreatedAt || current?.createdAt || ""));
  const nextAt = Date.parse(String(next?.playbackCreatedAt || next?.createdAt || ""));
  if (Number.isFinite(currentAt) && Number.isFinite(nextAt) && currentAt !== nextAt) {
    return currentAt < nextAt ? "current_older" : "current_newer";
  }
  return "ambiguous";
}

export function createRevocableRelayStream(body, options = {}) {
  if (!body || typeof body.getReader !== "function") return body;
  const reader = body.getReader();
  const isActive = typeof options.isActive === "function"
    ? options.isActive
    : async () => false;
  const abort = typeof options.abort === "function" ? options.abort : () => {};
  const intervalMs = Number.isFinite(options.checkIntervalMs)
    ? Math.max(1_000, Math.min(30_000, options.checkIntervalMs))
    : 3_000;
  const schedule = options.schedule ?? globalThis.setInterval;
  const unschedule = options.unschedule ?? globalThis.clearInterval;
  let timer = null;
  let checking = false;
  let closed = false;
  let controllerRef = null;

  const stop = () => {
    if (timer !== null) {
      try { unschedule(timer); } catch (_) { /* already cleared */ }
      timer = null;
    }
  };
  const revoke = async () => {
    if (closed) return;
    closed = true;
    stop();
    try { await reader.cancel("PLAYBACK_SUPERSEDED"); } catch (_) { /* already closed */ }
    try { abort(); } catch (_) { /* already aborted */ }
    try { controllerRef?.error(new Error("PLAYBACK_SUPERSEDED")); } catch (_) { /* already closed */ }
  };
  const verify = async () => {
    if (closed || checking) return;
    checking = true;
    try {
      if (await isActive() !== true) await revoke();
    } catch (_) {
      // The coordinator is the revocation authority. Losing it must not turn a
      // single-slot stream into an unbounded fail-open provider connection.
      await revoke();
    } finally {
      checking = false;
    }
  };

  return new ReadableStream({
    start(controller) {
      controllerRef = controller;
      timer = schedule(verify, intervalMs);
    },
    async pull(controller) {
      if (closed) return;
      const { done, value } = await reader.read();
      if (closed) return;
      if (done) {
        closed = true;
        stop();
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      stop();
      try { await reader.cancel(reason); } catch (_) { /* already closed */ }
      try { abort(); } catch (_) { /* already aborted */ }
    },
  });
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
