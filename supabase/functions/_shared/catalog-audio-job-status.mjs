import { isDiscoverySourceId } from './discovery-catalog.mjs';

export function activeAudioJobState(job, now = Date.now()) {
  if (!job || (job.queue_expires_at && Date.parse(job.queue_expires_at) <= now)) return null;
  if (job.state === 'running') {
    return Date.parse(job.lease_until || job.lease_expires_at || '') > now ? 'running' : null;
  }
  return ['queued', 'retry_wait'].includes(job.state) ? job.state : null;
}

export function audioJobFields(status) {
  const state = ['queued', 'retry_wait', 'running'].includes(status) ? status : null;
  return { audio_language_validation_job_status: state, audioLanguageValidationJobStatus: state };
}

export function titleAudioJobState(variants) {
  const states = variants.map(v => v.__audio_job_status);
  return states.includes('running') ? 'running' : states.includes('queued') ? 'queued'
    : states.includes('retry_wait') ? 'retry_wait' : null;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Only callers holding visible, owned variants may use this internal projection.
// Neither editable metadata nor a synthetic "pending" observation proves work.
export async function attachAudioJobStates(db, variants, userId, now = Date.now()) {
  const owned = variants.filter(v => v.user_id === userId && v.item_type === 'movie');
  for (const v of owned) v.__audio_job_status = null;
  if (!owned.length) return;
  for (let start = 0; start < owned.length; start += 50) {
    const batch = owned.slice(start, start + 50);
    const selected = [];
    for (const v of batch) {
      if (await isDiscoverySourceId(v.source_id, userId) && v.playback_hint?.targetUrl) selected.push(v);
    }
    const legacy = await db.from('catalog_file_audio_validation_jobs')
      .select('variant_id,source_id,external_id,state,queue_expires_at,lease_expires_at')
      .eq('requested_by', userId).in('variant_id', batch.map(v => v.id))
      .in('state', ['queued', 'running', 'retry_wait']);
    if (!legacy.error) for (const job of legacy.data || []) {
      const v = batch.find(v => v.id === job.variant_id && v.source_id === job.source_id && v.external_id === job.external_id);
      if (v) v.__audio_job_status = activeAudioJobState(job, now);
    }
    if (!selected.length) continue;
    const result = await db.from('catalog_selection_audio_jobs')
      .select('external_id,url_sha256,state,lease_until')
      .in('external_id', selected.map(v => v.external_id))
      .in('state', ['queued', 'running', 'retry_wait']);
    if (result.error) continue; // Deploy/schema outages must never invent activity.
    const byId = new Map((result.data || []).map(j => [`${j.external_id}:${j.url_sha256}`, j]));
    for (const v of selected) {
      const job = byId.get(`${v.external_id}:${await sha256(v.playback_hint.targetUrl)}`);
      if (job) {
        v.__audio_job_status = activeAudioJobState(job, now);
      }
    }
  }
}
