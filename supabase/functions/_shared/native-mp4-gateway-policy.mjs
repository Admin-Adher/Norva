// Optional, server-owned MP4 source rollout through the existing session HLS
// surface. The Gateway copies compatible video instead of exposing /raw.
export function useNativeMp4Gateway({ sourceId, itemType, container, allowlist = '' } = {}) {
  if (itemType !== 'movie' || container !== 'mp4' || typeof sourceId !== 'string') return false;
  const raw = String(allowlist).trim();
  if (!raw || raw.length > 4096) return false;
  const sources = raw.split(/[\s,]+/);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (sources.length > 64 || sources.some((id) => !uuid.test(id))) return false;
  return sources.includes(sourceId);
}
