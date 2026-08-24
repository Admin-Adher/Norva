// Consume direct-provider responses under one end-to-end deadline. Callers hold
// the provider-affinity fallback lease until these helpers have read, bounded,
// decoded, and (for JSON) parsed the complete body.

export class BoundedProviderResponseError extends Error {
  constructor(kind) {
    const message = kind === "timeout"
      ? "Provider response deadline exceeded"
      : kind === "too_large"
      ? "Provider response exceeded the byte limit"
      : "Unable to read provider response";
    super(message);
    this.name = "BoundedProviderResponseError";
    this.kind = kind;
  }
}

export async function fetchBoundedProviderJson(url, options) {
  return await fetchAndConsumeProviderResponse(url, options, (bytes) => {
    if (bytes.byteLength === 0) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      return null;
    }
  });
}

export async function fetchBoundedProviderText(url, options) {
  return await fetchAndConsumeProviderResponse(
    url,
    options,
    (bytes) => new TextDecoder().decode(bytes),
  );
}

async function fetchAndConsumeProviderResponse(url, options, consume) {
  const timeoutMs = Number(options?.timeoutMs);
  const maxBytes = Number(options?.maxBytes);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new BoundedProviderResponseError("invalid_limit");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
      signal: controller.signal,
      redirect: options?.redirect ?? "follow",
    });
    const bytes = await readBoundedResponseBytes(response, maxBytes);
    // Keep this inside the timed/leased operation. Parsing is synchronously
    // bounded by maxBytes even though AbortController cannot interrupt CPU work.
    return { response, value: consume(bytes) };
  } catch (error) {
    if (error instanceof BoundedProviderResponseError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new BoundedProviderResponseError("timeout");
    }
    throw new BoundedProviderResponseError("network");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseBytes(response, maxBytes) {
  const rawContentLength = response.headers?.get?.("content-length") ?? "";
  if (/^\d+$/.test(rawContentLength) && Number(rawContentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BoundedProviderResponseError("too_large");
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new BoundedProviderResponseError("network");
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedProviderResponseError("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
