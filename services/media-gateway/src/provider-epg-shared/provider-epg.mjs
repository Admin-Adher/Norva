import { BoundedProviderResponseError } from './bounded-provider-response.mjs';

// Parse one XMLTV element at a time: provider feeds routinely exceed 80 MB.
// Only the requested time window is retained, under independent memory limits.
export const XMLTV_MAX_BYTES = 128 * 1024 * 1024;
const MAX_ELEMENT_CHARS = 1024 * 1024;
const MAX_CHANNELS = 20000;
export function providerEpgChannelKey(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fhd|full\s*hd|hd|uhd|4k|sd|hevc|h265|h264|fr)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\b([a-z]{2,})\s+(\d+)\b/g, '$1$2').replace(/\s+/g, ' ');
}
function epgEndpoint(value, base) {
  const url = new URL(value, base), host = url.hostname.toLowerCase();
  const octets = host.split('.').map(Number);
  const privateIp = octets.length === 4 && octets.every(Number.isInteger) &&
    (octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
      (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127));
  if (!['http:', 'https:'].includes(url.protocol) || host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.includes(':') || !host.includes('.') || privateIp || url.username || url.password)
    throw new BoundedProviderResponseError('invalid_epg_url');
  return url;
}
const clean = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).trim();
const attr = (text, key) => clean(text.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(v => v !== undefined));
const texts = (text, tag) => [...text.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map(m => clean(m[1]));
const first = (text, tag) => texts(text, tag)[0] || '';
export function xmltvDateMs(value) {
  const m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!m) return Date.parse(value);
  const [, y, mo, d, h, mi, s, tz] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${tz ? tz.slice(0, 3) + ':' + tz.slice(3) : 'Z'}`);
}

function parser(options) {
  const channels = new Map(), programmes = [], programmeKeys = new Set();
  const filtered = Array.isArray(options.channelIds) || Array.isArray(options.channelNames);
  const wantedIds = new Set(options.channelIds || []), wantedNames = new Set((options.channelNames || []).map(providerEpgChannelKey));
  let buffer = '', hasRoot = false, hasEnd = false, truncated = false;
  const consume = (kind, attrs, body) => {
    if (kind === 'channel') {
      const id = attr(attrs, 'id').slice(0, 256);
      if (!id) return;
      const names = texts(body, 'display-name').map(n => n.slice(0, 256)).filter(Boolean);
      if (filtered && !wantedIds.has(id) && !names.some(n => wantedNames.has(providerEpgChannelKey(n))) && !channels.has(id)) return;
      if (!channels.has(id) && channels.size >= MAX_CHANNELS) { truncated = true; return; }
      const previous = channels.get(id);
      const aliases = [...new Set([...(previous?.aliases || []), ...names])].slice(0, 24);
      channels.set(id, previous ? { ...previous, aliases } : {
        id, name: names[0] || id, aliases, icon: attr(body.match(/<icon\b([^>]*)/i)?.[1] || '', 'src') || null,
      });
      return;
    }
    const channelId = attr(attrs, 'channel').slice(0, 256);
    if (filtered && !wantedIds.has(channelId) && !channels.has(channelId)) return;
    const startMs = xmltvDateMs(attr(attrs, 'start')), stopMs = xmltvDateMs(attr(attrs, 'stop'));
    if (!channelId || !Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs
      || stopMs <= options.windowStartMs || startMs >= options.windowEndMs) return;
    const key = `${channelId}:${startMs}:${stopMs}`;
    if (programmeKeys.has(key)) return;
    if (programmes.length >= options.maxProgrammes) { truncated = true; return; }
    programmeKeys.add(key);
    programmes.push({ channelId, start: new Date(startMs).toISOString(), stop: new Date(stopMs).toISOString(),
      title: first(body, 'title').slice(0, 512) || 'Programme', subtitle: first(body, 'sub-title').slice(0, 512) || null,
      description: first(body, 'desc').slice(0, 6000), category: texts(body, 'category').slice(0, 8), icon: null });
  };
  return {
    write(chunk) {
      buffer += chunk;
      if (/<\/tv\s*>/i.test(buffer)) hasEnd = true;
      if (!hasRoot) {
        const root = /<tv(?:\s|>)/i.exec(buffer);
        if (!root && buffer.length > MAX_ELEMENT_CHARS) throw new BoundedProviderResponseError('invalid_xmltv');
        if (!root) return;
        hasRoot = true; buffer = buffer.slice(root.index);
      }
      while (buffer) {
        const open = /<(channel|programme)\b([^>]*)>/i.exec(buffer);
        if (!open) { buffer = buffer.slice(-512); break; }
        if (open.index) buffer = buffer.slice(open.index);
        const endMatch = new RegExp(`</${open[1]}\\s*>`, 'i').exec(buffer);
        const end = endMatch?.index ?? -1;
        if (end < 0) {
          if (buffer.length > MAX_ELEMENT_CHARS) throw new BoundedProviderResponseError('too_large');
          break;
        }
        consume(open[1].toLowerCase(), open[2], buffer.slice(open[0].length, end));
        buffer = buffer.slice(end + endMatch[0].length);
      }
    },
    result() {
      if (!hasRoot || !hasEnd || /<(?:channel|programme)\b/i.test(buffer)) throw new BoundedProviderResponseError('invalid_xmltv');
      // Some valid feeds have programmes but omit the optional channel definitions.
      for (const p of programmes) if (!channels.has(p.channelId) && channels.size < MAX_CHANNELS)
        channels.set(p.channelId, { id: p.channelId, name: p.channelId, aliases: [] });
      return { channels: [...channels.values()], programmes, truncated };
    },
  };
}

export function parseProviderXmltv(xml, options) {
  const p = parser(options);
  for (let at = 0; at < xml.length; at += 32768) p.write(xml.slice(at, at + 32768));
  return p.result();
}

export async function fetchProviderXmltv(url, options) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.timeoutMs || 45000);
  let reader, upstream;
  try {
    let endpoint = epgEndpoint(url), response;
    for (let hop = 0; hop <= 3; hop++) {
      response = await (options.fetch || fetch)(endpoint.href, { headers: options.headers, signal: controller.signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || hop === 3) throw new BoundedProviderResponseError('invalid_epg_url');
      endpoint = epgEndpoint(location, endpoint);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { response, value: null };
    }
    const length = Number(response.headers.get('content-length'));
    if (length > XMLTV_MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new BoundedProviderResponseError('too_large');
    }
    const p = parser(options), decoder = new TextDecoder();
    upstream = response.body?.getReader();
    let bytes = 0;
    if (!upstream) throw new BoundedProviderResponseError('invalid_xmltv');
    // Some declared feeds are .xml.gz files without Content-Encoding. Detect
    // actual gzip bytes; fetch may already have decoded HTTP gzip responses.
    const prefixParts = []; let prefixSize = 0;
    while (prefixSize < 2) {
      const part = await upstream.read(); if (part.done) break;
      prefixParts.push(part.value); prefixSize += part.value.byteLength;
    }
    if (prefixSize > XMLTV_MAX_BYTES) throw new BoundedProviderResponseError('too_large');
    const prefix = new Uint8Array(prefixSize); let prefixAt = 0;
    for (const part of prefixParts) { prefix.set(part, prefixAt); prefixAt += part.byteLength; }
    const body = new ReadableStream({
      start(c) { if (prefixSize) c.enqueue(prefix); },
      async pull(c) { const part = await upstream.read(); if (part.done) c.close(); else c.enqueue(part.value); },
      cancel() { return upstream.cancel(); },
    });
    reader = (prefix[0] === 0x1f && prefix[1] === 0x8b ? body.pipeThrough(new DecompressionStream('gzip')) : body).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > XMLTV_MAX_BYTES) throw new BoundedProviderResponseError('too_large');
      p.write(decoder.decode(value, { stream: true }));
    }
    p.write(decoder.decode());
    return { response, value: p.result() };
  } catch (error) {
    if (controller.signal.aborted) throw new BoundedProviderResponseError('timeout');
    throw error;
  } finally {
    await reader?.cancel().catch(() => {}); reader?.releaseLock(); clearTimeout(timer);
    await upstream?.cancel().catch(() => {}); upstream?.releaseLock();
  }
}

// Only follow a guide explicitly declared by the playlist, never guess a host.
export function declaredM3uEpgUrl(text, playlistUrl) {
  const header = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).find(l => /^#EXTM3U\b/i.test(l.trim()));
  if (!header) return '';
  const declared = header.match(/\b(?:x-tvg-url|url-tvg|tvg-url)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const value = (declared?.[1] || declared?.[2] || '').trim();
  if (!value || value.includes(',') || value.length > 4096) return '';
  try {
    return epgEndpoint(value, playlistUrl).href;
  } catch { return ''; }
}
