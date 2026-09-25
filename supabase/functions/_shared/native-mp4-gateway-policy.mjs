// Transport admission is generic; authorization and the exact owned-file codec
// proof are still mandatory at the call site. A provider name is not evidence.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Native decoders support finite containers beyond browser MP4. Size authority
// must still come from an exact server probe, never a caller's playback hint.
export function nativeVodFileProof(ownedHint = {}, now = Date.now()) {
  const p = ownedHint.codecProfile || ownedHint.codec_profile || {};
  const probedAt = Date.parse(p.probedAt || p.probed_at || '');
  const kind = String(p.container || '').toLowerCase().split(',')[0];
  const origin = String(p.probeSource || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!(origin === 'gatewayprobe' || (origin === 'gatewayinband' && p.metadataComplete === true))
    || !Number.isFinite(probedAt) || probedAt > now || now - probedAt > 14 * 86400_000
    || !['matroska', 'mkv', 'mov', 'mp4', 'mpegts', 'ts', 'avi', 'mpeg', 'ogg', 'flv'].includes(kind)
    || !Number.isSafeInteger(p.fileSizeBytes) || p.fileSizeBytes < 1024) return null;
  return { fileSizeBytes: p.fileSizeBytes,
    durationSeconds: Number.isFinite(p.durationSeconds) ? p.durationSeconds : null };
}

export function validNativeMp4Grant(grant, sessionId, publicBase = '') {
  try {
    if (grant?.protocol !== 1 || !UUID.test(sessionId) || !publicBase) return false;
    const access = new URL(String(grant.url || ''));
    const base = new URL(publicBase);
    if (access.protocol !== 'https:' || access.username || access.password || access.hash
      || !/^[A-Za-z0-9_-]{43}$/.test(access.searchParams.get('token') || '')
      || [...access.searchParams.keys()].length !== 1
      || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || base.origin !== access.origin) return false;
    const prefix = base.pathname.replace(/\/$/, '');
    return access.pathname === `${prefix}/sessions/${sessionId}/native.mp4`;
  } catch { return false; }
}

export function useNativeMp4Gateway({ sourceId, itemType, container, enabled = true } = {}) {
  // Movies have an exact, server-owned probe and a completed-playback receipt.
  // Series retain their current lane until the equivalent binding is available.
  // Callers may disable the optimization, but clients cannot authorize it.
  return enabled === true && itemType === 'movie' && container === 'mp4'
    && typeof sourceId === 'string' && UUID.test(sourceId);
}

// Call only with the exact owned movie profile, not merged request hints or a
// grouped title's sibling. Unknown/stale/ambiguous tracks keep the HLS lane.
export function browserNativeMp4Proof(ownedHint = {}, requestedHint = {}, now = Date.now()) {
  const p = ownedHint.codecProfile || ownedHint.codec_profile || {};
  const token = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const probedAt = Date.parse(p.probedAt || p.probed_at || '');
  // metadataComplete is a Matroska-prefix attestation, not an MP4 probe flag.
  if (token(p.probeSource) !== 'gatewayprobe'
    || !Number.isFinite(probedAt) || probedAt > now || now - probedAt > 14 * 86400_000
    || !['mp4', 'movmp4m4a3gp3g2mj2'].includes(token(p.container))
    || !['h264', 'avc1'].includes(token(p.videoCodec))
    || !['yuv420p', 'yuvj420p'].includes(token(p.videoPixelFormat))
    || !Number.isSafeInteger(p.fileSizeBytes) || p.fileSizeBytes < 1024
    || !Array.isArray(p.audioTracks) || !p.audioTracks.length
    || !Array.isArray(p.subtitles)) return null;
  const tracks = p.audioTracks;
  if (tracks.some(track => !track || typeof track !== 'object'
    || !Number.isSafeInteger(track.index) || track.index < 0)
    || new Set(tracks.map(track => track.index)).size !== tracks.length) return null;
  const defaults = tracks.filter(track => track.default === true);
  const first = tracks[0];
  // Native browser track selection is not an absolute FFmpeg stream selector.
  // Admit only when both default and first audio are the same safe AAC track.
  if (defaults.length > 1 || (defaults.length && defaults[0] !== first)
    || token(first.codec) !== 'aac' || token(first.profile) !== 'lc'
    || !Number.isInteger(first.channels) || first.channels < 1 || first.channels > 2) return null;
  const requested = requestedHint.audioStreamIndex ?? requestedHint.audio_stream_index;
  const subtitle = requestedHint.subtitleStreamIndex ?? requestedHint.subtitle_stream_index;
  if ((requested != null && (typeof requested === 'boolean' || String(requested).trim() === ''
      || !Number.isSafeInteger(Number(requested)) || Number(requested) !== first.index))
    || subtitle != null || requestedHint.burnSubtitles === true || requestedHint.burn_subtitles === true) return null;
  const duration = Number(p.durationSeconds);
  return { fileSizeBytes: p.fileSizeBytes,
    durationSeconds: Number.isFinite(duration) && duration > 0 && duration <= 86400 ? duration : null };
}
