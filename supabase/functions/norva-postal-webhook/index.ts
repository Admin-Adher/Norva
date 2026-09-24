// Postal receive-only canary webhook. Does not replace or call any Resend worker.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { handlePostalWebhookRequest } from '../_shared/postal-webhook-http.mjs';
import trustedConfig from './trusted-keys.json' with { type: 'json' };

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? '';
type VerifiedPostalEvent = { eventId: string; bodySha256: string; event: string;
  deliveryKey: string; providerMessageId: number; timestamp: number; providerStatus: string | null };
const admin = url && key ? createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
}) : null;

Deno.serve((req) => handlePostalWebhookRequest(req, {
  // The Edge worker's bundled filesystem contains imported resources, not
  // arbitrary sibling files. This public-key-only config must be imported.
  loadConfig: async () => trustedConfig,
  ledger: admin ? { applyEvent: async (event: VerifiedPostalEvent) => {
    const { data, error } = await admin.rpc('norva_apply_postal_canary_event', {
      p_event_uuid: event.eventId, p_body_sha256: event.bodySha256, p_event: event.event,
      p_delivery_key: event.deliveryKey, p_provider_message_id: event.providerMessageId,
      p_event_at: new Date(event.timestamp).toISOString(), p_provider_status: event.providerStatus,
    });
    if (error) throw new Error('persistence_unavailable');
    return data;
  } } : null,
}));
