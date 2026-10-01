// Operator-created, short-lived configuration; absent from every normal release.
// The isolated database must attest its identity before it can receive a request.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function validPlayQaConfig(value, userId, now = Date.now()) {
  if (!value || value.mode !== 'isolated-google-play-retention' || !UUID.test(userId || '')
      || value.userId !== userId || !UUID.test(value.runId || '')
      || value.url !== 'http://norva-play-retention-qa-rest:3000'
      || typeof value.key !== 'string' || value.key.length < 32) return false;
  const start = Date.parse(value.createdAt), end = Date.parse(value.expiresAt);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end
    && end - start <= 4 * 60 * 60 * 1000;
}

export async function playQaContext(userId, createClient, dependencies = {}) {
  // Edge workers bundle modules into a virtual filesystem. Operator secrets
  // live in the existing host-mounted directory, never in that module bundle.
  const read = dependencies.read || (() => Deno.readTextFile('/home/deno/functions/_shared/play-retention-qa.config.json'));
  let config;
  try { config = JSON.parse(await read()); }
  catch (error) {
    if (error?.name === 'NotFound') return null;
    throw new Error('play_qa_configuration_unavailable');
  }
  if (!validPlayQaConfig(config, userId, dependencies.now?.() ?? Date.now())) return null;
  const qaFetch = dependencies.fetch || fetch;
  const db = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== config.url || !url.pathname.startsWith('/rest/v1/')) throw new Error('play_qa_route_rejected');
      url.pathname = url.pathname.slice('/rest/v1'.length);
      return qaFetch(url.toString(), { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    } },
  });
  const result = await db.rpc('norva_play_qa_identity');
  if (result.error || result.data?.runId !== config.runId || result.data?.userId !== userId
      || result.data?.environment !== 'SANDBOX' || result.data?.productionWrites !== false
      || result.data?.expiresAt !== config.expiresAt) throw new Error('play_qa_identity_rejected');
  return { db, metadata: { mode: 'sandbox', expiresAt: config.expiresAt, runId: config.runId } };
}
