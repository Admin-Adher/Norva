// Operational dispatcher. Claims, provider leases, certification and publication
// remain in the existing authenticated Edge/SQL pipeline. No provider URL here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const counters = ['processed', 'attempted', 'queued', 'identified', 'verified', 'inconclusive', 'deferred', 'failed', 'scanned'];
export function safeResult(value) {
  const r = {};
  for (const key of counters) r[key] = Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : 0;
  for (const key of ['skipped', 'code', 'outcome']) {
    if (typeof value?.[key] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value[key])) r[key] = value[key];
  }
  if (typeof value?.hasMore === 'boolean') r.hasMore = value.hasMore;
  return r;
}
export function delayFor(result, failures = 0) {
  const code = result.skipped || result.code || '';
  if (result.httpError) return Math.min(20 * 60_000, 60_000 * 2 ** Math.min(failures, 5));
  if (/strict-analysis-deferred|automatic-queue-full/.test(code)) return 180_000;
  if (/revoked|disabled|not-visible|not-ready|paused/.test(code)) return 15 * 60_000;
  if (/viewer|playback|provider|circuit|footprint|account/.test(code) && code !== 'metadata-no-language') return 3 * 60_000;
  if (/capacity|queue-full|busy/.test(code)) return 30_000;
  if (result.hasMore === false || /exhausted|not-due/.test(code)) return 15 * 60_000;
  if (result.processed > 0 || result.scanned > 0) return 1500;
  return 60_000;
}
// ffprobe follows opaque redirects and therefore reserves the network lane
// exclusively. Leave a quiet interval across each even-minute cron tick so
// queued strict captures can actually start, rather than starving indefinitely.
export function intakeWindowOpen(now = Date.now()) {
  const phase = now % 120_000;
  return phase >= 20_000 && phase < 50_000;
}
export function recoverState(state, sources, now = Date.now()) {
  if (!state) state = { schema: 1, startedAt: new Date(now).toISOString(), sources: {} };
  if (state.schema !== 1) throw new Error('Unsupported campaign state');
  for (const source of sources) {
    const entry = state.sources[source.id] ||= { turn: 0, calls: 0, totals: {}, nextAt: now, failures: 0 };
    if (entry.inFlight) {
      // The Edge request may still own a 20-minute intake lease. Never reset it.
      entry.nextAt = Math.max(entry.nextAt, entry.inFlight + 21 * 60_000);
      delete entry.inFlight;
    }
  }
  return state;
}
export function chooseSource(state, sources, busy, now = Date.now()) {
  return sources.filter(s => !busy.has(s.id) && state.sources[s.id].nextAt <= now)
    .sort((a, b) => state.sources[a.id].nextAt - state.sources[b.id].nextAt || state.sources[a.id].calls - state.sources[b.id].calls)[0];
}
function atomic(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export async function main() {
  const root = process.env.CAMPAIGN_STATE_DIR || '/state';
  const config = JSON.parse(fs.readFileSync(process.env.CAMPAIGN_CONFIG || '/config/campaign.json', 'utf8'));
  if (!config.sources?.length || config.sources.some(s => !/^[0-9a-f-]{36}$/.test(s.id) || !/^[0-9a-f-]{36}$/.test(s.userId))) throw new Error('Invalid campaign scope');
  const url = new URL(config.edgeUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid Edge URL');
  const file = path.join(root, 'state.json');
  const state = recoverState(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null, config.sources);
  const busy = new Set();
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  const save = () => atomic(file, state);
  const heartbeat = setInterval(() => atomic(path.join(root, 'health.json'), { at: Date.now(), inFlight: busy.size, stopping }), 10_000);
  save();
  async function dispatch(source) {
    const entry = state.sources[source.id];
    const metadata = source.xtream && entry.turn % 3 === 0;
    entry.inFlight = Date.now(); busy.add(source.id); save();
    let result;
    try {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.NORVA_BACKFILL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: source.userId, sourceId: source.id, type: 'movie', ...(metadata ? { providerMetadataOnly: true } : { automaticUnknowns: true }) }),
        signal: AbortSignal.timeout(180_000), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); result = { httpError: response.status }; }
      else { const body = await response.text(); if (body.length > 65536) throw new Error('Oversize response'); result = safeResult(JSON.parse(body)); }
    } catch (_) { result = { httpError: 'transport' }; }
    entry.calls++; entry.turn++;
    entry.failures = result.httpError ? entry.failures + 1 : 0;
    for (const key of counters) entry.totals[key] = (entry.totals[key] || 0) + (result[key] || 0);
    entry.lastResult = result;
    entry.lastAt = new Date().toISOString();
    entry.nextAt = Date.now() + delayFor(result, entry.failures);
    // Unknown HTTP outcome: respect the longest intake lease, even after a restart.
    if (result.httpError) entry.nextAt = Math.max(entry.nextAt, entry.inFlight + 21 * 60_000);
    delete entry.inFlight; busy.delete(source.id); save();
    console.log(JSON.stringify({ at: entry.lastAt, source: source.label, lane: metadata ? 'provider-metadata' : 'exact-profile', ...result }));
  }
  try {
    while (!stopping) {
      // Operator completion is based on the independent exact-variant audit,
      // never on aggregate counters or a single cursor exhaustion response.
      if (fs.existsSync(path.join(root, 'STOP'))) { await new Promise(r => setTimeout(r, 2000)); continue; }
      // Leave a second global slot available to the minute-based strict audio
      // worker. Filling both slots with intake can starve its queued jobs.
      if (busy.size < 1 && intakeWindowOpen()) {
        const source = chooseSource(state, config.sources, busy);
        if (source) { dispatch(source).catch(() => { stopping = true; process.exitCode = 1; }); continue; }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    while (busy.size) await new Promise(r => setTimeout(r, 500));
  } finally { clearInterval(heartbeat); save(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Campaign startup failed'); process.exitCode = 1; });
