// Preparatory integration only. No production entry point imports this module.
import { verifyPostalWebhook } from './postal-webhook-verifier.mjs';

const keyPattern = /^norva-postal-canary-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');

export function createPostalCanaryLedger({ rpc, recipientHmacKey }) {
  if (typeof rpc !== 'function' || !(recipientHmacKey instanceof Uint8Array) || recipientHmacKey.length < 32) {
    throw new Error('trusted_ledger_configuration_required');
  }
  const cryptoKey = crypto.subtle.importKey('raw', recipientHmacKey,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return {
    async reserve(deliveryKey, payloadSha256, recipient) {
      if (!keyPattern.test(deliveryKey) || typeof recipient !== 'string' ||
          !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)) throw new Error('invalid_internal_claim');
      const recipientHmac = hex(await crypto.subtle.sign('HMAC', await cryptoKey,
        new TextEncoder().encode(recipient.trim().toLowerCase())));
      return await rpc('norva_reserve_postal_bound_canary', {
        p_delivery_key: deliveryKey, p_payload_sha256: payloadSha256, p_recipient_hmac: recipientHmac,
      });
    },
    async finish(deliveryKey, attemptToken, outcome) {
      return await rpc('norva_finish_postal_canary', {
        p_delivery_key: deliveryKey, p_attempt_token: attemptToken, p_state: outcome.state,
        p_provider_message_id: outcome.providerMessageId ?? null,
      });
    },
    async applyEvent(event) {
      return await rpc('norva_apply_postal_canary_event', {
        p_event_uuid: event.eventId, p_body_sha256: event.bodySha256, p_event: event.event,
        p_delivery_key: event.deliveryKey, p_provider_message_id: event.providerMessageId,
        p_event_at: new Date(event.timestamp).toISOString(), p_provider_status: event.providerStatus,
      });
    },
  };
}

export async function handlePostalCanaryWebhook(rawBytes, headers, options = {}) {
  const response = (status, code) => ({ status, code });
  if (options.enabled !== true) return response(503, 'disabled');
  if (!options.ledger?.applyEvent) return response(503, 'unavailable');
  const contentType = headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return response(415, 'unsupported_media_type');
  const event = await verifyPostalWebhook(rawBytes, headers, options.trustedKeys, options.nowMs ?? Date.now());
  if (!event.valid) return response(401, 'invalid_signature_or_event');
  if (event.direction !== 'outgoing' || !keyPattern.test(event.deliveryKey ?? '')) return response(422, 'unbound_event');
  try {
    const saved = await options.ledger.applyEvent(event);
    if (saved?.result === 'applied' || saved?.result === 'duplicate') return response(200, saved.result);
    if (saved?.result === 'conflict') return response(409, 'event_conflict');
    // Never acknowledge an unknown message or missing API receipt as processed.
    return response(503, 'reconciliation_required');
  } catch { return response(503, 'unavailable'); }
}
