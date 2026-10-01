// Only the already signed, imported Selection wrapper may use this adapter.
// Keep its URL in child claims so the same narrow origin policy applies to every
// playlist, key and segment. No caller-supplied origin or generic proxy endpoint.
const WRAPPER = 'https://movierulz.babuperumana.workers.dev/proxy';
const ORIGIN = 'https://hls2.vcdnx.com';
const MAX_PLAYLIST = 2_000_000;
const fail = () => new Error('Selection media is temporarily unavailable');

function originUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.origin !== ORIGIN || u.username || u.password || u.hash
      || !/^\/hls\/[A-Za-z0-9_+=.-]{8,512}\/[A-Za-z0-9!_+=.-]{1,200}$/.test(u.pathname)
      || [...u.searchParams.keys()].some(k => /^(url|host|username|password)$/i.test(k))) return null;
    return u;
  } catch { return null; }
}

export function selectionVodOrigin(raw) {
  try {
    const u = new URL(raw);
    if (u.origin + u.pathname !== WRAPPER || u.username || u.password || u.hash
      || u.searchParams.getAll('url').length !== 1 || u.searchParams.getAll('ext').length > 1
      || [...u.searchParams.keys()].some(k => !['url', 'ext'].includes(k))) return null;
    return originUrl(u.searchParams.get('url'));
  } catch { return null; }
}

function concatenate(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function proxySelectionVodOrigin(request, target, sign, fetcher = fetch) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  let reader;
  const close = async reason => {
    clearTimeout(timer);
    abort.abort();
    try { await reader?.cancel(reason); } catch { /* Already closed. */ }
  };
  try {
    const response = await fetcher(target.href, {
      method: 'GET', redirect: 'error', signal: abort.signal,
      headers: { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Accept-Encoding': 'identity' },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw fail();
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0, done = false;
    while (size < 1024 && !done) {
      const next = await reader.read(); done = next.done;
      if (next.value) { chunks.push(next.value); size += next.value.length; }
    }
    const prefix = concatenate(chunks, size);
    const headers = new Headers({ 'Cache-Control': 'private, no-store' });
    if (new TextDecoder().decode(prefix.subarray(0, 7)) === '#EXTM3U') {
      if (size > MAX_PLAYLIST) throw fail();
      while (!done) {
        const next = await reader.read(); done = next.done;
        if (next.value) {
          size += next.value.length;
          if (size > MAX_PLAYLIST) throw fail();
          chunks.push(next.value);
        }
      }
      const text = new TextDecoder().decode(concatenate(chunks, size));
      // Byte-range playlists need separate transformed-offset accounting.
      if (/#EXT-X-BYTERANGE:|BYTERANGE=/i.test(text)) throw fail();
      const child = async raw => {
        const url = originUrl(new URL(raw, target).href);
        if (!url) throw fail();
        const wrapper = new URL(WRAPPER);
        wrapper.searchParams.set('url', url.href);
        return sign(wrapper.href);
      };
      const lines = [];
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') && !trimmed.includes('URI="')) lines.push(line);
        else if (trimmed.startsWith('#')) {
          let cursor = 0, rewritten = '';
          for (const match of line.matchAll(/URI="([^"]+)"/g)) {
            rewritten += line.slice(cursor, match.index) + `URI="${await child(match[1])}"`;
            cursor = match.index + match[0].length;
          }
          lines.push(rewritten + line.slice(cursor));
        } else lines.push(await child(trimmed));
      }
      await close();
      headers.set('Content-Type', 'application/vnd.apple.mpegurl');
      return new Response(request.method === 'HEAD' ? null : lines.join('\n'), { headers });
    }
    const png = [137,80,78,71,13,10,26,10].every((b, i) => prefix[i] === b);
    let offset = 0;
    if (png) {
      offset = -1;
      for (let i = 8; i < 188 && i + 4 * 188 < prefix.length; i++) {
        if ([0,1,2,3,4].every(n => prefix[i + n * 188] === 0x47)) { offset = i; break; }
      }
      if (offset < 0) throw fail();
      headers.set('Content-Type', 'video/mp2t');
    } else {
      const type = response.headers.get('content-type') || 'application/octet-stream';
      if (/text\/html/i.test(type) || new TextDecoder().decode(prefix.subarray(0, 100)).trimStart().startsWith('<')) throw fail();
      headers.set('Content-Type', type);
    }
    if (request.method === 'HEAD') { await close(); return new Response(null, { headers }); }
    let first = true;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (first) {
            first = false;
            if (prefix.length > offset) controller.enqueue(prefix.subarray(offset));
            if (done) { clearTimeout(timer); controller.close(); }
            return;
          }
          const next = await reader.read();
          if (next.done) { clearTimeout(timer); controller.close(); }
          else controller.enqueue(next.value);
        } catch { await close(); controller.error(fail()); }
      },
      cancel: close,
    });
    return new Response(body, { headers });
  } catch {
    await close();
    throw fail();
  }
}
