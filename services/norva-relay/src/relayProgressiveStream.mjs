// Recover a broken progressive download inside the SAME playback session.
// Never stitch bytes using a filename/extension: a strong ETag, exact range and
// total size must all agree. Unknown/live/encoded bodies retain normal streaming.
export function boundedProgressiveRange(rangeHeader, total = NaN, browserVideo = false) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!match || (match[2] && !browserVideo)) return null; // Preserve engine, suffix and multipart ranges.
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : null;
  if (requestedEnd !== null && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start)) return null;
  const cap = start + 8 * 1024 * 1024 - 1;
  const end = requestedEnd === null ? cap : Math.min(cap, requestedEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (Number.isSafeInteger(total) && total > 0) {
    if (start >= total) return null;
    return `bytes=${start}-${Math.min(end, total - 1)}`;
  }
  return `bytes=${start}-${end}`;
}

export function progressiveRangeIdentity(response) {
  const headers = response.headers;
  const etag = headers.get('etag')?.trim();
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  const length = Number(headers.get('content-length'));
  if (!etag || !/^"[^"\r\n]*"$/.test(etag) || (encoding && encoding !== 'identity')
      || !Number.isSafeInteger(length) || length <= 0) return null;
  if (response.status === 200) return { start: 0, end: length - 1, total: length, etag };
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') || '');
  if (response.status !== 206 || !range) return null;
  const [start, end, total] = range.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start
      || total <= end || end - start + 1 !== length) return null;
  return { start, end, total, etag };
}

// fetch() and raw sockets can deliver only a few hundred bytes per default read.
// Running the retry timer and JS stream wrappers for every fragment exhausted
// the Worker's CPU allowance during real VOD playback (exceededCpu). Let the
// native Workers stream aggregate bytes, without buffering a complete range.
// A small first read preserves startup; subsequent reads retain <= 256 KiB.
// Non-Workers/default streams keep their existing behavior.
export function createRelayBodyReader(body) {
  let byob;
  try {
    byob = body.getReader({ mode: 'byob' });
    if (typeof byob.readAtLeast === 'function') {
      let first = true;
      return {
        read(remaining = Infinity) {
          const size = Math.min(remaining, first ? 16 * 1024 : 256 * 1024);
          first = false;
          return byob.readAtLeast(size, new Uint8Array(size));
        },
        cancel(reason) { return byob.cancel(reason); },
      };
    }
  } catch (_) { /* Not a native byte stream. */ }
  if (byob) byob.releaseLock();
  return body.getReader();
}

export function createResumableProgressiveBody(response, options) {
  const identity = progressiveRangeIdentity(response);
  if (!identity || !response.body || typeof options?.fetchRange !== 'function') return response.body;
  const maxRetries = Math.max(0, Math.min(2, options.maxRetries ?? 2));
  const readTimeoutMs = Math.max(1, options.readTimeoutMs ?? 15_000);
  let reader = createRelayBodyReader(response.body);
  let abort = options.abort || (() => {});
  let offset = identity.start;
  let retries = 0;
  let closed = false;
  let readTimer = null;
  let resumeTimer = null;

  const release = (reason) => {
    clearTimeout(readTimer);
    readTimer = null;
    clearTimeout(resumeTimer);
    resumeTimer = null;
    try { abort(); } catch (_) { /* already closed */ }
    try { void reader.cancel(reason).catch(() => {}); } catch (_) { /* already closed */ }
  };
  const read = async () => {
    try {
      return await Promise.race([
        reader.read(identity.end + 1 - offset),
        new Promise((_, reject) => {
          readTimer = setTimeout(() => reject(new Error('RELAY_UPSTREAM_TIMEOUT')), readTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(readTimer); readTimer = null; }
  };

  return new ReadableStream({
    async pull(controller) {
      while (!closed) {
        try {
          const { done, value } = await read();
          if (closed) return;
          if (done) throw new Error('RELAY_UPSTREAM_TRUNCATED');
          if (!value?.byteLength) continue;
          if (value.byteLength > identity.end + 1 - offset) throw new Error('RELAY_UPSTREAM_LENGTH_MISMATCH');
          offset += value.byteLength;
          controller.enqueue(value);
          if (offset === identity.end + 1) {
            closed = true;
            controller.close();
            release('range-complete');
          }
          return;
        } catch (error) {
          if (closed) return;
          release('range-interrupted');
          if (retries >= maxRetries || error?.message === 'RELAY_UPSTREAM_LENGTH_MISMATCH') {
            closed = true;
            controller.error(error);
            return;
          }
          retries++;
          try {
            // No new provider connection while revoked/offline authority is
            // unavailable, and never a parallel connection during recovery.
            if (await options.isActive?.() !== true) throw new Error('PLAYBACK_SUPERSEDED');
            if (closed) return;
            const pendingAbort = new AbortController();
            abort = () => pendingAbort.abort();
            let next;
            try {
              resumeTimer = setTimeout(abort, Math.max(1, options.resumeTimeoutMs ?? 15_000));
              next = await options.fetchRange({ start: offset, end: identity.end, etag: identity.etag, signal: pendingAbort.signal });
            } finally { clearTimeout(resumeTimer); resumeTimer = null; }
            if (closed) {
              try { next.abort?.(); } catch (_) {}
              try { void next.response?.body?.cancel().catch(() => {}); } catch (_) {}
              return;
            }
            abort = next.abort || abort;
            const resumed = progressiveRangeIdentity(next.response);
            if (!resumed || next.response.status !== 206 || resumed.start !== offset
                || resumed.end !== identity.end || resumed.total !== identity.total
                || resumed.etag !== identity.etag) {
              try { abort(); } catch (_) {}
              try { void next.response.body?.cancel().catch(() => {}); } catch (_) {}
              throw new Error('RELAY_UNSAFE_RANGE_RESUME');
            }
            reader = createRelayBodyReader(next.response.body);
            options.onResume?.({ attempt: retries, reason: error?.message === 'RELAY_UPSTREAM_TIMEOUT' ? 'timeout' : 'interrupted' });
          } catch (resumeError) {
            if (closed) return;
            closed = true;
            release('resume-failed');
            controller.error(resumeError);
          }
        }
      }
    },
    cancel(reason) {
      closed = true;
      release(reason);
    },
  });
}
