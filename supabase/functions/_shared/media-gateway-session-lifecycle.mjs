export const MEDIA_GATEWAY_SESSION_CLEANUP_TIMEOUT_MS = 8_000;

export async function cleanupMediaGatewaySession(options = {}) {
  const baseUrl = String(options.baseUrl || "").trim().replace(/\/+$/, "");
  // Preserve the configured bearer value byte-for-byte. Creation uses the same
  // secret without normalization, so cleanup must not silently trim it.
  const token = String(options.token || "");
  const sessionId = String(options.sessionId || "").trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!baseUrl || !token || !sessionId || typeof fetchImpl !== "function") {
    return { ok: false, status: 0, alreadyAbsent: false, reason: "invalid-cleanup-input" };
  }

  try {
    const response = await fetchImpl(
      `${baseUrl}/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(MEDIA_GATEWAY_SESSION_CLEANUP_TIMEOUT_MS),
      },
    );
    const alreadyAbsent = response.status === 404;
    return {
      ok: response.ok || alreadyAbsent,
      status: Number(response.status) || 0,
      alreadyAbsent,
      reason: response.ok || alreadyAbsent ? null : "gateway-cleanup-refused",
    };
  } catch (_) {
    return { ok: false, status: 0, alreadyAbsent: false, reason: "gateway-cleanup-unavailable" };
  }
}
