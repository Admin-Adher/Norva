// Only the documented Norva health response may confirm recovery.
export async function readCustomerServiceHealth(
  base: string,
  service: "gateway" | "relay",
  request: typeof fetch = fetch,
): Promise<boolean | null> {
  if (!base) return null;
  try {
    const response = await request(`${base.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(4500), redirect: "error",
    });
    if (response.status >= 500) { await response.body?.cancel(); return true; }
    if (!response.ok) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader();
    if (!reader) return null;
    let body = "", size = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 131072) return null;
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    const health = JSON.parse(body);
    const expected = service === "gateway" ? "norva-media-gateway" : "norva-edge";
    return health?.service === expected && typeof health.ok === "boolean" ? !health.ok : null;
  } catch (error) {
    // Malformed content is a monitoring problem, not evidence of an outage.
    return error instanceof SyntaxError ? null : true;
  }
}
