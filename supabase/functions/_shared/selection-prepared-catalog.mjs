import { SELECTION_TESTED_VOD_FEEDS, testedSelectionVodEntries } from './selection-tested-vod.mjs';
import { SELECTION_CURATED_CHANNELS } from './selection-curated-channels.mjs';
import { SELECTION_VOD_FEEDS } from './selection-vod.mjs';
import { SELECTION_LIVE_QUARANTINE } from './selection-live-quarantine.mjs';
let revisionPromise;
export function selectionPreparedRevision() {
  return revisionPromise ||= (async () => {
    const data = JSON.stringify(['prepared-v1', SELECTION_CURATED_CHANNELS, SELECTION_LIVE_QUARANTINE,
      SELECTION_VOD_FEEDS, SELECTION_TESTED_VOD_FEEDS.map(feed => testedSelectionVodEntries(feed.id))]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  })();
}
// Prepared Selection contains public catalogue data only. Owner/source/generation
// bindings are created afterwards by the existing fenced importer.
const rowFields = ['item_type', 'external_id', 'parent_external_id', 'title', 'subtitle',
  'poster_url', 'backdrop_url', 'metadata', 'playback_hint', 'available'];
export function selectionTemplateRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100000) throw new Error('Invalid Selection template');
  return rows.map(row => Object.fromEntries(rowFields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
}

export async function preparedSelectionCatalog({ db, key, build, assertCurrent = async () => {} }) {
  await assertCurrent();
  const cached = await db.from('selection_prepared_catalogs').select('payload')
    .eq('revision', key).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!cached.error && cached.data?.payload?.version === 1) {
    const payload = cached.data.payload;
    await assertCurrent();
    return { ...payload, rows: selectionTemplateRows(payload.rows), reused: true };
  }
  const value = await build();
  const payload = { version: 1, rows: selectionTemplateRows(value.rows), sources: value.sources || [],
    truncated: !!value.truncated, truncationReason: value.truncationReason || null };
  await assertCurrent();
  // Do not spread a transient partial upstream result to new owners.
  if (!payload.truncated && payload.sources.every(source => source.status === 'loaded')) {
    const result = await db.from('selection_prepared_catalogs').upsert({ revision:key, payload,
      expires_at:new Date(Date.now() + 300000).toISOString() }, { onConflict:'revision' });
    // During a rolling schema deployment or cache outage normal import remains
    // authoritative. This cache never supplies owner authorization or readiness.
    if (result.error) console.warn('[selection] prepared cache write unavailable');
  }
  return { ...payload, reused:false };
}
