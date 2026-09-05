import { BoundedProviderResponseError } from "./bounded-provider-response.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ITEMS = 100_000;
const DEFAULT_MAX_LINE_CHARS = 256 * 1024;

function positiveSafeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function attribute(value, name) {
  const match = value.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1]?.trim() ?? "";
}

function entryTitle(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ',' && !quoted) return line.slice(index + 1).trim();
  }
  return 'Norva channel';
}

/**
 * A strict, cheap validation for the beginning of an extended M3U document.
 * A UTF-8 BOM and leading whitespace are accepted, but an HTML page that only
 * happens to mention #EXTM3U later in its body is not.
 */
export function hasExtendedM3uHeader(value) {
  return /^\uFEFF?\s*#EXTM3U(?:\s|$)/i.test(String(value ?? ""));
}

export function countExtendedM3uEntries(value) {
  return (String(value ?? "").match(/^\s*#EXTINF\b/gim) ?? []).length;
}

/**
 * Consume an M3U response incrementally. The catalogue size is bounded by an
 * explicit item/byte budget, but reaching either budget is a successful,
 * inspectable truncation rather than a 413 rejection. This keeps large valid
 * catalogues usable while protecting an Edge isolate from unbounded input.
 */
export async function readM3uPlaylistStream(stream, options = {}) {
  const maxBytes = positiveSafeInteger(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxItems = positiveSafeInteger(options.maxItems, DEFAULT_MAX_ITEMS);
  const maxLineChars = positiveSafeInteger(
    options.maxLineChars,
    DEFAULT_MAX_LINE_CHARS,
  );
  const reader = stream?.getReader?.();
  if (!reader) {
    return {
      items: [],
      bytesRead: 0,
      headerDetected: false,
      truncated: false,
      truncationReason: null,
    };
  }

  const decoder = new TextDecoder();
  const items = [];
  let buffered = "";
  let bytesRead = 0;
  let headerDetected = false;
  let pending = null;
  let truncated = false;
  let truncationReason = null;

  const consumeLine = (rawLine) => {
    const line = String(rawLine ?? "").trim();
    if (!line) return false;
    if (!headerDetected && /^\uFEFF?#EXTM3U(?:\s|$)/i.test(line)) {
      headerDetected = true;
    }
    if (/^#EXTINF\b/i.test(line)) {
      pending = {
        title: entryTitle(line),
        tvgId: attribute(line, "tvg-id") || attribute(line, "tvg-name"),
        logo: attribute(line, "tvg-logo"),
        group: attribute(line, "group-title"),
      };
      return false;
    }
    if (line.startsWith("#")) return false;
    if (pending && /^https?:\/\//i.test(line)) {
      items.push({ ...pending, url: line });
      pending = null;
      return items.length >= maxItems;
    }
    return false;
  };

  const consumeText = (value) => {
    buffered += value;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > maxLineChars) {
        throw new BoundedProviderResponseError("too_large");
      }
      if (consumeLine(line)) return true;
    }
    if (buffered.length > maxLineChars) {
      throw new BoundedProviderResponseError("too_large");
    }
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) consumeText(tail);
        if (buffered && items.length < maxItems) consumeLine(buffered);
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new BoundedProviderResponseError("network");
      }

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) {
        truncated = true;
        truncationReason = "byte_limit";
        await reader.cancel().catch(() => undefined);
        break;
      }

      const accepted = value.byteLength > remaining
        ? value.subarray(0, remaining)
        : value;
      bytesRead += accepted.byteLength;
      const itemLimitReached = consumeText(
        decoder.decode(accepted, { stream: true }),
      );
      if (itemLimitReached) {
        truncated = true;
        truncationReason = "item_limit";
        await reader.cancel().catch(() => undefined);
        break;
      }
      if (value.byteLength > remaining || bytesRead >= maxBytes) {
        truncated = true;
        truncationReason = "byte_limit";
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    items,
    bytesRead,
    headerDetected,
    truncated,
    truncationReason,
  };
}

export async function fetchM3uPlaylistStream(url, options = {}) {
  const timeoutMs = positiveSafeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
      redirect: options.redirect ?? "follow",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        response,
        items: [],
        bytesRead: 0,
        headerDetected: false,
        truncated: false,
        truncationReason: null,
      };
    }
    return {
      response,
      ...await readM3uPlaylistStream(response.body, options),
    };
  } catch (error) {
    if (error instanceof BoundedProviderResponseError) throw error;
    if (
      controller.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw new BoundedProviderResponseError("timeout");
    }
    throw new BoundedProviderResponseError("network");
  } finally {
    clearTimeout(timer);
  }
}
