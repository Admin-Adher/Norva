// Operational dispatcher. Claims, provider leases, certification and publication
// remain in the existing authenticated Edge/SQL pipeline. No provider URL here.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const counters = ['processed', 'attempted', 'queued', 'identified', 'verified', 'inconclusive', 'deferred', 'failed', 'scanned'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Discovery grants no network admission. Each existing Edge/SQL guard remains
// authoritative, including a source revoked between discovery and dispatch.
export async function discoverSources(url, key, request = fetch) {
  if (!key) throw new Error('Missing discovery credential');
  const found = []; const seen = new Set(); let after = null;
  for (let page = 0; page < 100; page++) {
    const response = await request(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_after: after, p_limit: 128 }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Discovery unavailable'); }
    const text = await response.text();
    if (text.length > 65536) throw new Error('Oversize discovery');
    const rows = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length > 128) throw new Error('Invalid discovery');
    for (const row of rows) {
      if (!uuid.test(row.id) || !uuid.test(row.userId) || typeof row.xtream !== 'boolean'
          || seen.has(row.id) || (after && row.id <= after)) throw new Error('Invalid discovery scope');
      seen.add(row.id); after = row.id; found.push({ id: row.id, userId: row.userId, xtream: row.xtream });
    }
    if (rows.length < 128) return found;
  }
  throw new Error('Discovery pagination incomplete'); // Never dispatch a partial inventory.
}
export function reconcileSources(state, discovered, original, now = Date.now()) {
  const labels = new Map(original.map(s => [s.id, s.label]));
  const seen = new Set();
  return discovered.map(source => {
    if (seen.has(source.id)) throw new Error('Duplicate source');
    seen.add(source.id);
    const current = state.sources[source.id];
    if (current?.userId && current.userId !== source.userId) throw new Error('Source owner changed');
    if (!current) state.sources[source.id] = recoverState(null, [source], now).sources[source.id];
    const entry = state.sources[source.id];
    entry.userId = source.userId;
    // A type change can enable metadata, but never reset existing delays.
    if (source.xtream && !entry.lanes.metadata) entry.lanes.metadata = {
      calls: 0, totals: {}, failures: 0, nextAt: Math.max(now, entry.blockedUntil || 0, entry.nextAt || 0) };
    entry.label ||= labels.get(source.id) || `Catalogue ${Object.keys(state.sources).indexOf(source.id) + 1}`;
    return { ...source, label: entry.label };
  });
}
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
  if (/viewer|playback|provider|circuit|footprint|account|live-session/.test(code) && code !== 'metadata-no-language') return 3 * 60_000;
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
  if (!state) state = { schema: 2, startedAt: new Date(now).toISOString(), sources: {} };
  if (![1, 2].includes(state.schema)) throw new Error('Unsupported campaign state');
  for (const source of sources) {
    const entry = state.sources[source.id] ||= { turn: 0, calls: 0, totals: {}, nextAt: now, failures: 0 };
    entry.lanes ||= {};
    for (const lane of source.xtream ? ['metadata', 'exact'] : ['exact']) {
      entry.lanes[lane] ||= { calls: 0, totals: {}, failures: 0, nextAt: entry.nextAt ?? now };
    }
  }
  // A dynamically discovered source can be absent from the original cohort.
  // Recover its uncertain request as well, even if it has since been removed.
  for (const entry of Object.values(state.sources)) {
    if (entry.inFlight) {
      // The Edge request may still own a 20-minute intake lease. Never reset it.
      entry.blockedUntil = Math.max(entry.blockedUntil || 0, entry.inFlight + 21 * 60_000);
      for (const lane of Object.values(entry.lanes || {})) lane.nextAt = Math.max(lane.nextAt, entry.blockedUntil);
      delete entry.inFlight; delete entry.inFlightLane;
    }
  }
  state.schema = 2;
  return state;
}
export function chooseWork(state, sources, busy, now = Date.now()) {
  const candidates = [];
  for (const source of sources) {
    const entry = state.sources[source.id];
    if (busy.has(source.id) || (entry.blockedUntil || 0) > now) continue;
    for (const lane of source.xtream ? ['metadata', 'exact'] : ['exact']) {
      const pending = entry.lanes[lane];
      if (pending.nextAt > now || (lane === 'exact' && !intakeWindowOpen(now))) continue;
      candidates.push({ source, lane, pending });
    }
  }
  // Give the narrow exact-probe window priority. Outside it metadata can use
  // the campaign's ONE slot; strict capture still has the other network slot.
  // FIFO by nextAt makes finite metadata batches rotate between providers.
  return candidates.sort((a, b) => Number(b.lane === 'exact') - Number(a.lane === 'exact')
    || a.pending.nextAt - b.pending.nextAt || a.pending.calls - b.pending.calls)[0];
}
export function recordResult(entry, lane, result, now = Date.now()) {
  const pending = entry.lanes[lane];
  for (const target of [entry, pending]) {
    target.calls++;
    target.failures = result.httpError ? target.failures + 1 : 0;
    for (const key of counters) target.totals[key] = (target.totals[key] || 0) + (result[key] || 0);
    target.lastResult = result;
    target.lastAt = new Date(now).toISOString();
  }
  entry.turn++;
  pending.nextAt = now + delayFor(result, pending.failures);
  const code = result.skipped || result.code || '';
  // Audio queue congestion blocks only exact work. Actual provider/viewer
  // occupancy, permission changes and uncertain transport block BOTH lanes.
  if (/viewer|playback|provider|circuit|footprint|account|live-session|revoked|disabled|not-visible|not-ready|paused/.test(code)
      && code !== 'metadata-no-language') {
    entry.blockedUntil = Math.max(entry.blockedUntil || 0, pending.nextAt);
  }
  if (result.httpError) {
    entry.blockedUntil = Math.max(entry.blockedUntil || 0, pending.nextAt, (entry.inFlight ?? now) + 21 * 60_000);
  }
  delete entry.inFlight; delete entry.inFlightLane;
  entry.nextAt = Math.max(entry.blockedUntil || 0, Math.min(...Object.values(entry.lanes).map(l => l.nextAt)));
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
  let sources = config.discovery ? [] : config.sources;
  let discoveryNextAt = 0;
  let discoveryOk = !config.discovery;
  const busy = new Set();
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  const save = () => atomic(file, state);
  const heartbeat = setInterval(() => atomic(path.join(root, 'health.json'), {
    at: Date.now(), inFlight: busy.size, stopping, discoveryOk, sourceCount: sources.length,
    ownerCount: new Set(sources.map(s => s.userId)).size }), 10_000);
  save();
  async function dispatch(source, lane) {
    const entry = state.sources[source.id];
    const metadata = lane === 'metadata';
    entry.inFlight = Date.now(); entry.inFlightLane = lane; busy.add(source.id); save();
    let result;
    try {
      const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.NORVA_BACKFILL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: source.userId, sourceId: source.id, type: 'movie', ...(metadata ? { providerMetadataOnly: true } : { automaticUnknowns: true }) }),
        signal: AbortSignal.timeout(180_000), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); result = { httpError: response.status }; }
      else { const body = await response.text(); if (body.length > 65536) throw new Error('Oversize response'); result = safeResult(JSON.parse(body)); }
    } catch (_) { result = { httpError: 'transport' }; }
    recordResult(entry, lane, result);
    busy.delete(source.id); save();
    console.log(JSON.stringify({ at: entry.lastAt, source: source.label, lane: metadata ? 'provider-metadata' : 'exact-profile', ...result }));
  }
  try {
    while (!stopping) {
      // Operator completion is based on the independent exact-variant audit,
      // never on aggregate counters or a single cursor exhaustion response.
      if (fs.existsSync(path.join(root, 'STOP'))) { await new Promise(r => setTimeout(r, 2000)); continue; }
      if (config.discovery && busy.size === 0 && Date.now() >= discoveryNextAt) {
        try {
          const discovered = await discoverSources(config.discovery.url, process.env.NORVA_CAMPAIGN_DISCOVERY_KEY);
          sources = reconcileSources(state, discovered, config.sources); discoveryOk = true; save();
          console.log(JSON.stringify({ at: new Date().toISOString(), event: 'source-discovery', sources: sources.length,
            owners: new Set(sources.map(s => s.userId)).size }));
          discoveryNextAt = Date.now() + 300000;
        } catch (_) {
          discoveryOk = false; sources = []; discoveryNextAt = Date.now() + 60000;
          console.log(JSON.stringify({ at: new Date().toISOString(), event: 'source-discovery-unavailable' }));
        }
      }
      // Leave a second global slot available to the minute-based strict audio
      // worker. Filling both slots with intake can starve its queued jobs.
      if (busy.size < 1) {
        const work = chooseWork(state, sources, busy);
        if (work) { dispatch(work.source, work.lane).catch(() => { stopping = true; process.exitCode = 1; }); continue; }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    while (busy.size) await new Promise(r => setTimeout(r, 500));
  } finally { clearInterval(heartbeat); save(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Campaign startup failed'); process.exitCode = 1; });
