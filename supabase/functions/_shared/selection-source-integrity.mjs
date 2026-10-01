import { isDiscoverySourceId } from './discovery-catalog.mjs';

const MAX_AGE_MS = 24 * 3600_000;
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');

// Advisory only. Never change catalogue visibility, language evidence or
// entitlement from a file defect. A repaired/replaced version must remain usable.
export async function attachSelectionSourceIntegrity({ db, userId, variants, now = Date.now() }) {
  const bound = [];
  const sources = new Map();
  for (const row of variants) {
    delete row.__source_integrity;
    if (row.user_id !== userId || row.item_type !== 'movie'
      || typeof row.external_id !== 'string' || !row.external_id.startsWith('norva-selection:movie:')) continue;
    if (!sources.has(row.source_id)) sources.set(row.source_id, await isDiscoverySourceId(row.source_id, userId));
    const target = row.playback_hint?.targetUrl;
    if (!sources.get(row.source_id) || typeof target !== 'string' || !target) continue;
    bound.push({ row, digest:await sha256(target) });
  }
  const ids = [...new Set(bound.map(({ row }) => row.external_id))];
  const evidence = new Map();
  for (let offset = 0; offset < ids.length; offset += 50) {
    const { data, error } = await db.from('catalog_selection_audio_jobs')
      .select('external_id,url_sha256,state,error_code,completed_at')
      .in('external_id', ids.slice(offset, offset + 50))
      .eq('state', 'failed').eq('error_code', 'SELECTION_AUDIO_SOURCE_TRUNCATED');
    if (error) throw error;
    for (const job of data || []) {
      const checkedAt = Date.parse(job.completed_at);
      if (job.state !== 'failed' || job.error_code !== 'SELECTION_AUDIO_SOURCE_TRUNCATED'
        || !Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > MAX_AGE_MS) continue;
      evidence.set(`${job.external_id}:${job.url_sha256}`, new Date(checkedAt).toISOString());
    }
  }
  let count = 0;
  for (const { row, digest } of bound) {
    const checkedAt = evidence.get(`${row.external_id}:${digest}`);
    if (!checkedAt) continue;
    row.__source_integrity = { status:'incomplete', checkedAt };
    count++;
  }
  return count;
}
