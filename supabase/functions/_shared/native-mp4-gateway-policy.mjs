// Optional, server-owned source rollout. Never expose the private /raw token.
export function validNativeMp4Grant(grant, sessionId, publicBase = '') {
  try {
    if (grant?.protocol !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) return false;
    const access = new URL(String(grant.url || ''));
    if (access.protocol !== 'https:' || access.username || access.password || access.hash
      || !/^[A-Za-z0-9_-]{43}$/.test(access.searchParams.get('token') || '')
      || [...access.searchParams.keys()].length !== 1) return false;
    let prefix = '';
    if (publicBase) {
      const base = new URL(publicBase);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
        || base.origin !== access.origin) return false;
      prefix = base.pathname.replace(/\/$/, '');
    }
    return access.pathname === `${prefix}/sessions/${sessionId}/native.mp4`;
  } catch { return false; }
}

export function useNativeMp4Gateway({ sourceId, itemType, container, allowlist = '', ownerHash, ownerAllowlist = '' } = {}) {
  if (itemType !== 'movie' || container !== 'mp4' || typeof sourceId !== 'string') return false;
  // A pilot account can exercise every owned provider through the native byte
  // cache without promoting those providers for other customers. This only
  // selects transport; the exact-file browser codec proof remains mandatory.
  const owners = String(ownerAllowlist).trim().split(/[\s,]+/).filter(Boolean);
  if (owners.length > 0 && owners.length <= 64
    && owners.every(value => /^[a-f0-9]{64}$/.test(value))
    && typeof ownerHash === 'string' && owners.includes(ownerHash)) return true;
  const raw = String(allowlist).trim();
  if (!raw || raw.length > 4096) return false;
  const sources = raw.split(/[\s,]+/);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (sources.length > 64 || sources.some((id) => !uuid.test(id))) return false;
  return sources.includes(sourceId);
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
  const defaults = tracks.filter(t => t.default === true);
  const first = tracks[0];
  // Native browser track selection is not an absolute FFmpeg stream selector.
  // Admit only when both default and first audio are the same safe AAC track.
  if (defaults.length > 1 || (defaults.length && defaults[0] !== first)
    || token(first.codec) !== 'aac' || token(first.profile) !== 'lc'
    || !Number.isInteger(first.channels) || first.channels < 1 || first.channels > 2) return null;
  const requested = requestedHint.audioStreamIndex ?? requestedHint.audio_stream_index;
  const subtitle = requestedHint.subtitleStreamIndex ?? requestedHint.subtitle_stream_index;
  if ((requested != null && Number(requested) !== first.index) || subtitle != null
    || requestedHint.burnSubtitles === true || requestedHint.burn_subtitles === true) return null;
  return { fileSizeBytes: p.fileSizeBytes, durationSeconds: Number(p.durationSeconds) || null };
}
