import { handlePostalCanaryWebhook } from './postal-durable-integration.mjs';

// Server-to-server boundary only. No send endpoint, cookies, CORS or payload log.
export async function handlePostalWebhookRequest(req, { loadConfig, ledger, readTimeoutMs = 3000 } = {}) {
  const reply = (status, code) => new Response(JSON.stringify({ code }), { status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  if (req.method !== 'POST') return reply(405, 'method_not_allowed');
  if (!/^\/(?:functions\/v1\/)?norva-postal-webhook\/?$/.test(new URL(req.url).pathname)) return reply(404, 'not_found');
  let config;
  try { config = await loadConfig(); } catch { return reply(503, 'disabled'); }
  if (config?.enabled !== true || !config.trustedKeys || !ledger?.applyEvent) return reply(503, 'disabled');
  const entries = Object.entries(config.trustedKeys);
  if (!entries.length || entries.length > 2 || entries.some(([kid, key]) =>
    !/^[A-Za-z0-9_-]{1,128}$/.test(kid) || typeof key !== 'string' || key.length > 4096)) return reply(503, 'disabled');
  if (!Object.hasOwn(config.trustedKeys, req.headers.get('x-postal-signature-kid')) || !req.headers.has('x-postal-signature-256')) {
    return reply(401, 'invalid_signature_or_event');
  }
  const length = req.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 32768)) return reply(413, 'body_too_large');
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, 'unsupported_media_type');
  if (!req.body) return reply(400, 'invalid_body');
  const reader = req.body.getReader(); let timer; let bytes = 0; const chunks = [];
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('read_timeout')), Math.min(5000, Math.max(1, readTimeoutMs))); });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) return reply(413, 'body_too_large');
      chunks.push(value);
    }
    const raw = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    const result = await handlePostalCanaryWebhook(raw, req.headers, { enabled: true, trustedKeys: config.trustedKeys, ledger });
    return reply(result.status, result.code);
  } catch (error) { return reply(error?.message === 'read_timeout' ? 408 : 400, 'invalid_body'); }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
