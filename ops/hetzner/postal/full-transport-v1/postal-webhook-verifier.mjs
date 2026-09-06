// Verifies raw bytes only. No public endpoint, auto key fetch or business mutation.
const events = new Set(['MessageSent', 'MessageDelayed', 'MessageDeliveryFailed', 'MessageHeld', 'MessageBounced']);
export async function verifyPostalWebhook(rawBytes, headers, trustedKeys = {}, nowMs = Date.now(), scope = 'canary') {
  try {
    if (!['canary','branded','mail'].includes(scope) || !(rawBytes instanceof Uint8Array) || rawBytes.length > 32768) return { valid: false };
    const kid = headers.get('X-Postal-Signature-KID');
    const signature = headers.get('X-Postal-Signature-256');
    const pem = Object.hasOwn(trustedKeys, kid) ? trustedKeys[kid] : null;
    if (!pem || !signature || !/^[A-Za-z0-9+/=\r\n]{100,1500}$/.test(signature)) return { valid: false };
    const decode = (text) => Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0));
    const der = decode(pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, ''));
    const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (key.algorithm.modulusLength < 2048) return { valid: false };
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signature), rawBytes)) return { valid: false };
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes));
    if (!events.has(event.event) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(event.uuid)) return { valid: false };
    if (typeof event.timestamp !== 'number') return { valid: false };
    const at = event.timestamp * 1000;
    if (!Number.isFinite(at) || at > nowMs + 300000 || at < nowMs - 172800000) return { valid: false };
    const message = event.event === 'MessageBounced' ? event.payload?.original_message : event.payload?.message;
    if (!Number.isSafeInteger(message?.id) || message.id <= 0) return { valid: false };
    const digest = await crypto.subtle.digest('SHA-256', rawBytes);
    return { valid: true, eventId: event.uuid, event: event.event, providerMessageId: message.id,
      direction: message.direction === 'outgoing' ? 'outgoing' : 'unknown',
      deliveryKey: (scope === 'canary'
        ? /^norva-postal-canary-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
        : scope === 'branded' ? /^norva-branded-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/: /^norva-mail-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/).test(message.tag ?? '') ? message.tag : null,
      providerStatus: ['Sent', 'SoftFail', 'HardFail', 'Held'].includes(event.payload?.status) ? event.payload.status : null,
      timestamp: at, bodySha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
      // Persist event UUID once and apply side effects in ONE DB transaction.
      requiresAtomicReplayGuard: true, inboxDeliveryProven: false };
  } catch { return { valid: false }; }
}
