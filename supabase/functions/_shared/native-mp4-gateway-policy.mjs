// Optional, server-owned source rollout. This selects only a byte-preserving
// transport; it never switches a native MP4 to FFmpeg or the browser engine.
export function useNativeMp4Gateway({ sourceId, itemType, container, allowlist = '' } = {}) {
  if (itemType !== 'movie' || container !== 'mp4' || typeof sourceId !== 'string') return false;
  const raw = String(allowlist).trim();
  if (!raw || raw.length > 4096) return false;
  const sources = raw.split(/[\s,]+/);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (sources.length > 64 || sources.some((id) => !uuid.test(id))) return false;
  return sources.includes(sourceId);
}

// Service-to-service Gateway URLs can be Docker-only. A native HTML video must
// receive the explicitly configured HTTPS ingress, never that internal origin.
// Only the already-signed raw capability moves; query/credential/path rewriting
// or a different playback canary must not silently change its destination.
export function nativeMp4PublicBytePipeUrl(pipeUrl, publicBase) {
  try {
    const pipe = new URL(pipeUrl);
    const base = new URL(publicBase);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
      || !base.hostname.includes('.') || /^(?:127\.|0\.|169\.254\.|\[|localhost(?:\.|$))/i.test(base.hostname)
      || pipe.search || pipe.hash || !/^\/raw\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pipe.pathname)) return null;
    return `${base.origin}${base.pathname.replace(/\/+$/, '')}${pipe.pathname}`;
  } catch {
    return null;
  }
}
