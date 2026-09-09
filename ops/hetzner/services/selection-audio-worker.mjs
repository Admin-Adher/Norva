import { createSelectionAudioGateway, getSelectionAudioManifest } from '../../../supabase/functions/_shared/selection-audio-gateway.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const priorityTitles = /^(Calabozos y Dragones|Raya y el |Avatar 2|Riverdance|Ponyo|X-Men 2$|Uma Aventura Lego$)/i;
const knownLanguage = value => typeof value === 'string' && /^[a-z]{2}$/.test(value) && value !== 'un';

export function createSelectionAudioRepository({ baseUrl, serviceKey, fetchImpl = fetch }) {
  if (!baseUrl || !serviceKey) throw new Error('SELECTION_AUDIO_CONFIGURATION_REQUIRED');
  async function rpc(name, body = {}) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Object.assign(new Error('SELECTION_AUDIO_DATABASE_ERROR'), { code: 'SELECTION_AUDIO_DATABASE_ERROR', retryable: true });
    return await response.json();
  }
  const identity = job => ({ p_external_id: job.external_id, p_url_sha256: job.url_sha256, p_lease_token: job.lease_token });
  return {
    seed: manifest => rpc('seed_selection_audio_jobs', { p_manifest: manifest }),
    claim: () => rpc('claim_selection_audio_job'),
    checkpoint: (job, profile, progress) => rpc('checkpoint_selection_audio_job', { ...identity(job), p_profile: profile, p_progress: progress }),
    finish: (job, result, errorCode = null, retryable = false) => rpc('finish_selection_audio_job', {
      ...identity(job), p_result: result, p_error_code: errorCode, p_retryable: retryable,
    }),
    pendingHydrations: () => rpc('pending_selection_audio_hydrations', { p_limit: 20 }),
    acknowledgeHydration: job => rpc('ack_selection_audio_hydration', { p_external_id: job.external_id, p_url_sha256: job.url_sha256 }),
    async hydrate(job) {
      const owners = await rpc('selection_audio_job_owners', { p_external_id: job.external_id, p_url_sha256: job.url_sha256 });
      let count = 0;
      for (const owner of owners || []) {
        // Re-read before every owner: removal, replacement or re-enrolment must
        // not resurrect a retired catalogue. RPC verifies this snapshot again.
        const snapshot = await rpc('norva_get_catalog_write_snapshot', { p_source_id: owner.source_id, p_user_id: owner.user_id });
        if (snapshot?.isCatalogVisible !== true) continue;
        try {
          count += Number(await rpc('hydrate_selection_audio_results', {
            p_source_id: owner.source_id, p_user_id: owner.user_id,
            p_generation_id: snapshot.generationId, p_head_revision: snapshot.headRevision,
            p_config_revision: snapshot.configRevision, p_source_visibility_epoch: snapshot.sourceVisibilityEpoch,
            p_user_visibility_epoch: snapshot.userVisibilityEpoch, p_external_ids: [job.external_id],
          })) || 0;
        } catch (error) {
          // The result is durable; a later import or repair pass retries hydration.
          // Do not turn successful speech analysis into another provider download.
          throw error;
        }
      }
      return count;
    },
  };
}

export async function processSelectionAudioJob({ repository, gateway, file, job, signal, onProgress = async () => {} }) {
  if (!file || file.externalId !== job.external_id || file.urlSha256 !== job.url_sha256) {
    await repository.finish(job, null, 'SELECTION_AUDIO_FILE_CHANGED', false);
    return { state: 'failed' };
  }
  let profile = job.profile?.fingerprint ? job.profile : null;
  let progress = job.progress?.trackPosition >= 0 ? job.progress : { trackPosition: 0, receipts: [], tracks: [], evidence: [] };
  let lostLease = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let checkpointChain = Promise.resolve();
  const checkpoint = () => {
    const next = checkpointChain.then(async () => {
    if (lostLease || signal?.aborted) throw Object.assign(new Error('SELECTION_AUDIO_INTERRUPTED'), { code: 'SELECTION_AUDIO_INTERRUPTED', retryable: true });
    if (!await repository.checkpoint(job, profile || {}, progress)) {
      lostLease = true;
      controller.abort();
      throw Object.assign(new Error('SELECTION_AUDIO_LEASE_LOST'), { code: 'SELECTION_AUDIO_LEASE_LOST' });
    }
    await onProgress();
    });
    checkpointChain = next.catch(() => {});
    return next;
  };
  let heartbeatPending = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatPending || lostLease) return;
    heartbeatPending = true;
    try { await checkpoint(); } catch { lostLease = true; controller.abort(); }
    finally { heartbeatPending = false; }
  }, 30_000);
  try {
    if (!profile) {
      profile = await gateway.probe(file, { signal: controller.signal });
      progress = { trackPosition: 0, receipts: [], tracks: [], evidence: [] };
      await checkpoint();
    }
    const sourceTracks = profile.audioTracks;
    while (progress.trackPosition < sourceTracks.length) {
      const track = sourceTracks[progress.trackPosition];
      const language = track.lang || track.language;
      if (knownLanguage(language)) {
        progress.tracks.push({ index: track.index, lang: language, codec: track.codec || null });
      } else {
        const args = { file, profile, jobId: job.id, subjectId: 'norva-selection-audio', trackIndex: track.index, signal: controller.signal };
        let windows = profile.durationSeconds >= 120 ? 6 : 4;
        for (let ordinal = progress.receipts.length; ordinal < windows; ordinal++) {
          const response = await gateway.analyzeTrackWindow({ ...args, windowOrdinal: ordinal + 1 });
          if (!response.providerDrained || !response.receipt) throw Object.assign(new Error('SELECTION_AUDIO_DRAIN_UNPROVEN'), { code: 'SELECTION_AUDIO_DRAIN_UNPROVEN', retryable: true });
          windows = response.windowCount;
          progress.receipts.push(response.receipt);
          await checkpoint();
        }
        const detection = await gateway.finalizeTrack({ ...args, receipts: progress.receipts });
        const identified = detection.verified === true && knownLanguage(detection.lang);
        progress.tracks.push({ index: track.index, lang: identified ? detection.lang : null, codec: track.codec || null });
        if (identified) progress.evidence.push({ index: track.index, evidence: detection.evidence });
      }
      progress.receipts = [];
      // Save the next track, so a crash never repeats an already certified track.
      progress.trackPosition++;
      await checkpoint();
    }
    const verified = progress.tracks.length > 0 && progress.evidence.length === progress.tracks.length;
    const result = { audioTracks: progress.tracks, subtitleTracks: profile.subtitleTracks || [], profile, verified,
      verification: { method: 'selection-strict-lid-v1', status: verified ? 'verified' : 'probed',
        urlSha256: file.urlSha256, profileFingerprint: profile.fingerprint, tracks: progress.evidence } };
    clearInterval(heartbeat);
    await checkpointChain;
    if (lostLease) return { state: 'lease_lost' };
    const saved = await repository.finish(job, result);
    if (!saved) return { state: 'lease_lost' };
    let hydrated = 0;
    try {
      hydrated = await repository.hydrate(job);
      await repository.acknowledgeHydration(job);
    }
    catch { return { state: 'completed', hydrated: 0, hydrationPending: true }; }
    return { state: 'completed', hydrated, languages: [...new Set(progress.tracks.map(t => t.lang).filter(Boolean))] };
  } catch (error) {
    clearInterval(heartbeat);
    await checkpointChain;
    if (lostLease) return { state: 'lease_lost' };
    if (error.resetRequired) {
      profile = null;
      progress = { trackPosition: 0, receipts: [], tracks: [], evidence: [] };
      if (!await repository.checkpoint(job, {}, progress)) return { state: 'lease_lost' };
    }
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code)
      ? error.code : 'SELECTION_AUDIO_ANALYSIS_ERROR';
    await repository.finish(job, null, code, error.retryable === true || signal?.aborted === true);
    return { state: error.retryable ? 'retry_wait' : 'failed', error: code };
  } finally { clearInterval(heartbeat); signal?.removeEventListener('abort', abort); }
}

export async function runSelectionAudioWorker(env = process.env) {
  const repository = createSelectionAudioRepository({ baseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
  const gateway = createSelectionAudioGateway({ gatewayUrl: env.MEDIA_GATEWAY_URL, gatewayToken: env.MEDIA_GATEWAY_TOKEN });
  const manifest = await getSelectionAudioManifest();
  const files = new Map(manifest.map(f => [f.externalId, f]));
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  const health = async (status = 'ready') => {
    if (env.SELECTION_AUDIO_HEALTH_FILE) await writeFile(env.SELECTION_AUDIO_HEALTH_FILE, JSON.stringify({ status, at: Date.now() }));
  };
  let seededAt = 0;
  while (!controller.signal.aborted) {
    try {
      await health();
      if (Date.now() - seededAt > 300_000) {
        const unknown = manifest.filter(f => f.hasUnknownAudioTracks || !f.knownAudioLanguages?.length);
        for (let offset = 0; offset < unknown.length; offset += 250) {
          await repository.seed(unknown.slice(offset, offset + 250).map(f => ({ externalId: f.externalId,
            urlSha256: f.urlSha256, priority: priorityTitles.test(f.title) ? 1000 : 0 })));
        }
        seededAt = Date.now();
      }
      for (const completed of await repository.pendingHydrations() || []) {
        try {
          await repository.hydrate(completed);
          await repository.acknowledgeHydration(completed);
        } catch { /* Durable pending flag retains it for the next pass. */ }
      }
      const job = await repository.claim();
      if (job?.external_id) {
        const result = await processSelectionAudioJob({ repository, gateway, file: files.get(job.external_id), job,
          signal: controller.signal, onProgress: health });
        console.log(JSON.stringify({ event: 'selection_audio_job', state: result.state,
          error: result.error || null, languages: result.languages || [], hydrated: result.hydrated || 0 }));
      } else await delay(15_000, undefined, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error(JSON.stringify({ event: 'selection_audio_worker', error: 'SELECTION_AUDIO_WORKER_RETRY' }));
      await health('retrying');
      await delay(30_000, undefined, { signal: controller.signal }).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runSelectionAudioWorker();
