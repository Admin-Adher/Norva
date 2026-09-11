import { SELECTION_TESTED_VOD_FEEDS, testedSelectionVodEntries, testedSelectionVodUrlAllowed } from './selection-tested-vod.mjs';
import { selectionVodIdentity, selectionVodExternalId } from './selection-vod.mjs';

const METHOD = 'whisper-strict-consensus-v4';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const encoder = new TextEncoder();
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const aliases = { eng:'en', spa:'es', por:'pt', fra:'fr', fre:'fr', deu:'de', ger:'de', ita:'it', jpn:'ja', zho:'zh', chi:'zh', kor:'ko', hin:'hi', ara:'ar', rus:'ru', tur:'tr', nld:'nl', dut:'nl' };
const language = value => typeof value !== 'string' ? null
  : /^[a-z]{2}$/.test(value) && value !== 'un' ? value
  : Object.hasOwn(aliases, value) ? aliases[value] : null;
const safeCodec = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,32}$/.test(value) ? value : null;

export class SelectionAudioGatewayError extends Error {
  constructor(code, { status = 0, retryable = false, retryAfterSeconds = 300, resetRequired = false, providerDrained = false } = {}) {
    // Never carry an upstream message, URL, bearer token or speech transcript.
    super(code);
    this.name = 'SelectionAudioGatewayError';
    Object.assign(this, { code, status, retryable, retryAfterSeconds, resetRequired, providerDrained });
  }
}
const fail = (code, options) => { throw new SelectionAudioGatewayError(code, options); };
export async function selectionAudioSha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

let filesPromise;
async function auditedFiles() {
  if (!filesPromise) filesPromise = (async () => {
    const files = new Map();
    for (const feed of SELECTION_TESTED_VOD_FEEDS) {
      for (const entry of testedSelectionVodEntries(feed.id)) {
        if (!testedSelectionVodUrlAllowed(feed.id, entry.url)) continue;
        const externalId = selectionVodExternalId(await selectionVodIdentity(feed.id, entry));
        files.set(externalId, { externalId, url:entry.url, urlSha256:await selectionAudioSha256(entry.url),
          feedId:feed.id, title:entry.title,
          knownAudioLanguages:[...new Set((entry.codecProfile?.audioTracks || [])
            .map(track => language(track.lang ?? track.language)).filter(Boolean))],
          hasUnknownAudioTracks:!entry.codecProfile?.audioTracks?.length || entry.codecProfile.audioTracks
            .some(track => !language(track.lang ?? track.language)) });
      }
    }
    return files;
  })();
  return filesPromise;
}

// Server-only manifest for seeding the durable queue. URLs must never be
// projected to the catalogue response together with job or receipt internals.
export async function getSelectionAudioManifest() {
  return [...(await auditedFiles()).values()].map(file => ({ ...file, knownAudioLanguages:[...file.knownAudioLanguages] }));
}

async function requireFile(input) {
  const file = object(input), expected = (await auditedFiles()).get(file.externalId);
  if (!expected || file.url !== expected.url || file.urlSha256 !== expected.urlSha256) {
    fail('SELECTION_AUDIO_FILE_NOT_AUDITED');
  }
  return { externalId: file.externalId, ...expected };
}

function tracks(value, { audio = false } = {}) {
  if (!Array.isArray(value) || value.length > 32 || (audio && !value.length)) fail('SELECTION_AUDIO_PROFILE_INVALID');
  const used = new Set();
  return value.map(raw => {
    const track = object(raw), index = track.index;
    if (!Number.isInteger(index) || index < 0 || index > 1024 || used.has(index)) fail('SELECTION_AUDIO_PROFILE_INVALID');
    used.add(index);
    return { index, lang: language(track.lang ?? track.language), codec: safeCodec(track.codec),
      ...(Number.isInteger(track.channels) && track.channels > 0 && track.channels <= 64 ? { channels: track.channels } : {}) };
  }).sort((a, b) => a.index - b.index);
}

async function normalizeProfile(value, file) {
  const raw = object(value);
  const durationSeconds = raw.durationSeconds, fileSizeBytes = raw.fileSizeBytes;
  const probeSource = String(raw.probeSource || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!finite(durationSeconds) || durationSeconds < 80 || durationSeconds > 86400
    || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0
    || typeof raw.probedAt !== 'string' || !Number.isFinite(Date.parse(raw.probedAt))
    || !['gatewayprobe','gatewayinband'].includes(probeSource)
    || (probeSource === 'gatewayinband' && raw.metadataComplete !== true)) fail('SELECTION_AUDIO_PROFILE_INVALID');
  const profile = { externalId:file.externalId, urlSha256:file.urlSha256,
    durationSeconds, fileSizeBytes, probedAt:new Date(raw.probedAt).toISOString(), probeSource,
    ...(probeSource === 'gatewayinband' ? { metadataComplete:true } : {}),
    audioTracks:tracks(raw.audioTracks, { audio:true }), subtitleTracks:tracks(raw.subtitleTracks ?? raw.subtitles ?? []) };
  const fingerprint = await selectionAudioSha256(JSON.stringify(profile));
  if (raw.fingerprint && raw.fingerprint !== fingerprint) fail('SELECTION_AUDIO_PROFILE_CHANGED');
  return { ...profile, fingerprint, windowCount:durationSeconds >= 120 ? 6 : 4 };
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedCapability(token, claims) {
  const payload = encoder.encode(JSON.stringify(claims));
  const key = await crypto.subtle.importKey('raw', encoder.encode(token), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return `${base64Url(payload)}.${base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, payload)))}`;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) fail('SELECTION_AUDIO_GATEWAY_INVALID_RESPONSE', { retryable:true });
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('SELECTION_AUDIO_GATEWAY_INVALID_RESPONSE', { retryable:true }); }
      chunks.push(value);
    }
    const joined = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(joined));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('SELECTION_AUDIO_GATEWAY_INVALID_RESPONSE', { retryable:true });
    return parsed;
  } catch (error) {
    if (error instanceof SelectionAudioGatewayError) throw error;
    fail('SELECTION_AUDIO_GATEWAY_INVALID_RESPONSE', { retryable:true });
  } finally { reader.releaseLock(); }
}

// This client accepts only the committed Selection file registry. It never
// accepts user metadata or invents a provider-account identity for public media.
// The durable caller owns the single-worker lease and checkpoints each receipt.
export function createSelectionAudioGateway({ gatewayUrl, gatewayToken, fetchImpl = fetch, now = Date.now,
  timeoutMs = 235_000 } = {}) {
  let base;
  try { base = new URL(gatewayUrl); } catch { fail('SELECTION_AUDIO_GATEWAY_CONFIG_INVALID'); }
  if (!['http:','https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || typeof gatewayToken !== 'string' || gatewayToken.length < 16) fail('SELECTION_AUDIO_GATEWAY_CONFIG_INVALID');
  const root = base.href.replace(/\/$/, '');
  const budget = Math.min(240_000, Math.max(1000, Number(timeoutMs) || 235_000));

  async function request(path, { body, capability, signal, budgetMs = budget } = {}) {
    if (signal?.aborted) fail('SELECTION_AUDIO_ABORTED', { retryable:true, retryAfterSeconds:30 });
    const deadline = AbortSignal.timeout(budgetMs);
    const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await fetchImpl(root + path, { method:'POST', redirect:'error', signal:abortSignal,
        headers:{ Authorization:`Bearer ${gatewayToken}`, 'Content-Type':'application/json',
          ...(capability ? { 'X-Norva-Byte-Pipe-Token':capability } : {}) },
        ...(body ? { body:JSON.stringify(body) } : {}) });
      const payload = await boundedJson(response);
      const providerDrained = payload.providerDrained === true && payload.providerDrainProtocol === 1;
      if (!response.ok) {
        if (response.status === 429 && ['LANGUAGE_ENRICHMENT_CAPACITY_BUSY','LID_CAPTURE_STORE_FULL',
          'LID_CAPTURE_ALREADY_RUNNING','LID_CAPTURE_COMPUTE_BUSY'].includes(payload.code) && providerDrained) {
          fail('SELECTION_AUDIO_CAPACITY_BUSY', { status:429, retryable:true, providerDrained:true, retryAfterSeconds:30 });
        }
        const busy = [409,429].includes(response.status) && ['account_busy','background_busy','viewer_preempted','LANGUAGE_VALIDATION_VIEWER_PREEMPTED','strict_lid_preempted'].includes(payload.code);
        const resetRequired = response.status === 409 && payload.code === 'strict_lid_checkpoint_reset_required' && payload.resetRequired === true;
        const retryable = busy || resetRequired || response.status >= 500 || response.status === 429;
        fail(resetRequired ? 'SELECTION_AUDIO_CHECKPOINT_RESET_REQUIRED' : busy ? 'SELECTION_AUDIO_VIEWER_BUSY' : 'SELECTION_AUDIO_GATEWAY_REJECTED',
          { status:response.status, retryable, resetRequired, providerDrained,
            retryAfterSeconds:busy ? 30 : 300 });
      }
      if (!providerDrained) fail('SELECTION_AUDIO_GATEWAY_DRAIN_UNCONFIRMED', { retryable:true, status:response.status });
      return payload;
    } catch (error) {
      if (error instanceof SelectionAudioGatewayError) throw error;
      fail(signal?.aborted ? 'SELECTION_AUDIO_ABORTED' : 'SELECTION_AUDIO_GATEWAY_TRANSPORT',
        { retryable:true, retryAfterSeconds:signal?.aborted ? 30 : 300 });
    }
  }

  async function context(args, finalize = false, captureAction = null) {
    const file = await requireFile(args.file);
    if (!HEX.test(args.profile?.fingerprint || '') || args.profile?.externalId !== file.externalId
      || args.profile?.urlSha256 !== file.urlSha256) fail('SELECTION_AUDIO_PROFILE_CHANGED');
    const profile = await normalizeProfile(args.profile, file);
    const { jobId, subjectId, trackIndex, windowOrdinal } = args;
    if (!UUID.test(jobId || '') || typeof subjectId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(subjectId)
      || !profile.audioTracks.some(track => track.index === trackIndex)
      || (!finalize && (!Number.isInteger(windowOrdinal) || windowOrdinal < 1 || windowOrdinal > profile.windowCount))) {
      fail('SELECTION_AUDIO_WINDOW_INVALID');
    }
    const claims = { v:1, sid:jobId, uid:subjectId, url:file.url, scope:'lid-legacy-full',
      selectionEnrichmentProtocol:1, selectionFeedId:file.feedId,
      enrichmentFileKey:await selectionAudioSha256(JSON.stringify(['selection',file.externalId,file.urlSha256])),
      fileSizeBytes:profile.fileSizeBytes, durationSeconds:profile.durationSeconds,
      windowCheckpointProtocol:1, jobId, profileFingerprint:profile.fingerprint, windowCount:profile.windowCount,
      ...(finalize ? { windowFinalize:true } : { windowOrdinal }), exp:Math.floor(now()/1000) + 300 };
    if (captureAction) {
      const indices = captureAction === 'capture' ? args.captureTrackIndices || [trackIndex] : [trackIndex];
      if (!['status','capture','infer','ack'].includes(captureAction) || finalize
        || !Array.isArray(indices) || indices.length < 1 || indices.length > 4 || indices[0] !== trackIndex
        || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index > 128
          || !profile.audioTracks.some(track => track.index === index))
        || (captureAction === 'infer' && !UUID.test(args.captureRelease || ''))) fail('SELECTION_AUDIO_CAPTURE_CLAIMS_INVALID');
      Object.assign(claims, { captureProtocol:1, captureAction, captureTrackIndex:trackIndex, captureTrackIndices:indices,
        ...(captureAction === 'infer' ? { captureRelease:args.captureRelease } : {}) });
    }
    return { profile, capability:await signedCapability(gatewayToken, claims) };
  }

  function windowReceipt(payload, args, profile) {
    if (payload.windowCheckpointProtocol !== 1 || payload.windowOrdinal !== args.windowOrdinal
      || payload.windowCount !== profile.windowCount || typeof payload.receipt !== 'string'
      || payload.receipt.length < 32 || payload.receipt.length > 64 * 1024 || !/^[a-zA-Z0-9._-]+$/.test(payload.receipt)) {
      fail('SELECTION_AUDIO_RECEIPT_INVALID', { retryable:true, providerDrained:true });
    }
    return { receipt:payload.receipt, windowOrdinal:args.windowOrdinal, windowCount:profile.windowCount, providerDrained:true };
  }

  async function captureRequest(args, action) {
    const { profile, capability } = await context(args, false, action);
    const payload = await request(`/detect-language/capture/${action}?index=${args.trackIndex}`, {
      capability, signal:args.signal, budgetMs:Math.min(budget, action === 'capture' ? 215_000 : action === 'infer' ? 60_000 : 10_000) });
    if (action === 'infer') return windowReceipt(payload, args, profile);
    if (action === 'ack') {
      if (payload.acknowledged !== true) fail('SELECTION_AUDIO_CAPTURE_ACK_INVALID', { retryable:true, providerDrained:true });
      return { acknowledged:true, providerDrained:true };
    }
    if (payload.captureProtocol !== 1 || typeof payload.captured !== 'boolean' || (action === 'capture' && !payload.captured)) {
      fail('SELECTION_AUDIO_CAPTURE_INVALID', { retryable:true, providerDrained:true });
    }
    if (!payload.captured) return { captured:false, providerDrained:true };
    if (!HEX.test(payload.sha256 || '') || !Number.isFinite(payload.expiresAt)
      || payload.expiresAt <= now() || payload.expiresAt > now() + 2 * 3600_000) {
      fail('SELECTION_AUDIO_CAPTURE_INVALID', { retryable:true, providerDrained:true });
    }
    return { captured:true, sha256:payload.sha256, expiresAt:payload.expiresAt, providerDrained:true };
  }

  return Object.freeze({
    async probe(fileInput, { signal } = {}) {
      const file = await requireFile(fileInput);
      const payload = await request('/probe-audio', { body:{ url:file.url,
        enrichmentFileKey:await selectionAudioSha256(JSON.stringify(['selection',file.externalId,file.urlSha256])) },
        signal, budgetMs:Math.min(budget, 120_000) });
      if (payload.audioProbeComplete !== true || payload.probeComplete !== true) fail('SELECTION_AUDIO_PROBE_INCOMPLETE', { retryable:true, providerDrained:true });
      const profile = object(payload.codecProfile);
      return normalizeProfile({ ...profile, audioTracks:payload.audioTracks,
        subtitleTracks:payload.subtitles ?? profile.subtitles ?? [] }, file);
    },
    async analyzeTrackWindow(args) {
      const { profile, capability } = await context(args);
      const payload = await request(`/detect-language?index=${args.trackIndex}&strict=1&dur=20`, { capability, signal:args.signal });
      return windowReceipt(payload, args, profile);
    },
    getCaptureStatus: args => captureRequest(args, 'status'),
    captureWindow: args => captureRequest(args, 'capture'),
    computeCapture: args => captureRequest(args, 'infer'),
    acknowledgeCapture: args => captureRequest(args, 'ack'),
    async finalizeTrack(args) {
      const { profile, capability } = await context(args, true);
      if (!Array.isArray(args.receipts) || args.receipts.length !== profile.windowCount
        || args.receipts.some(receipt => typeof receipt !== 'string' || receipt.length < 32 || receipt.length > 64 * 1024 || !/^[a-zA-Z0-9._-]+$/.test(receipt))) fail('SELECTION_AUDIO_RECEIPTS_INVALID');
      const payload = await request(`/detect-language/finalize?index=${args.trackIndex}`, { capability, body:{ receipts:args.receipts }, signal:args.signal, budgetMs:Math.min(budget, 30_000) });
      const lang = language(payload.language);
      const samples = Array.isArray(payload.samples) ? payload.samples : [];
      const valid = payload.verified === true && payload.confident === true && payload.validationStatus === 'verified'
        && payload.method === METHOD && !!lang && payload.evaluatedWindowCount === profile.windowCount
        && Number.isInteger(payload.consensus) && payload.consensus >= 4 && payload.consensus === samples.length
        && samples.length <= profile.windowCount && payload.sampleCount === samples.length
        && payload.rejectedSpeechSampleCount === 0 && finite(payload.minSampleProbability) && payload.minSampleProbability >= 0.95
        && payload.minSampleProbability <= 1 && Number.isInteger(payload.minSampleWordCount) && payload.minSampleWordCount >= 12
        && Number.isInteger(payload.minSampleUniqueWordCount) && payload.minSampleUniqueWordCount >= 8
        && samples.every(sample => language(sample.language) === lang && finite(sample.offset)
          && sample.offset >= 0 && sample.offset <= profile.durationSeconds - 20
          && finite(sample.probability) && sample.probability >= 0.95 && sample.probability <= 1
          && Number.isInteger(sample.wordCount) && sample.wordCount >= 12
          && Number.isInteger(sample.uniqueWordCount) && sample.uniqueWordCount >= 8)
        && payload.minSampleProbability === Math.min(...samples.map(sample => sample.probability))
        && payload.minSampleWordCount === Math.min(...samples.map(sample => sample.wordCount))
        && payload.minSampleUniqueWordCount === Math.min(...samples.map(sample => sample.uniqueWordCount))
        && new Set(samples.map(sample => sample.offset)).size === samples.length;
      if (!valid) {
        if (payload.verified === true) fail('SELECTION_AUDIO_EVIDENCE_INVALID', { retryable:true, providerDrained:true });
        return { verified:false, lang:null, status:'unidentified', providerDrained:true,
          evidence:{ protocol:1, method:METHOD, profileFingerprint:profile.fingerprint, windowCount:profile.windowCount } };
      }
      return { verified:true, lang, status:'verified', providerDrained:true,
        evidence:{ protocol:1, method:METHOD, status:'verified', profileFingerprint:profile.fingerprint,
          fileSizeBytes:profile.fileSizeBytes, profileProbedAt:profile.probedAt,
          streamIndex:args.trackIndex, windowCount:profile.windowCount, sampleDurationSeconds:20,
          consensus:payload.consensus, independentWindows:samples.length, language:lang,
          confidence:payload.minSampleProbability, minSampleProbability:payload.minSampleProbability,
          minSampleWordCount:payload.minSampleWordCount, minSampleUniqueWordCount:payload.minSampleUniqueWordCount,
          rejectedSpeechSampleCount:0,
          samples:samples.map(sample => ({ language:lang, offset:sample.offset, probability:sample.probability,
            wordCount:sample.wordCount, uniqueWordCount:sample.uniqueWordCount })) } };
    },
  });
}
