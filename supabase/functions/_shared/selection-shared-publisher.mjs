import { DISCOVERY_PLAYLIST_URL } from './discovery-catalog.mjs';
import { discoveryCatalogFields, fetchDiscoverySelection } from './discovery-sources.mjs';
import { selectionPreparedRevision, selectionTemplateRows } from './selection-prepared-catalog.mjs';
import { selectionSnapshotMovieManifests } from './selection-snapshot-tracks.mjs';
import { buildLiveMaterializationPlan } from './live-materialization.ts';

// Offline/public preparation: no account, entitlement or private state is read.
// A deployment prepares and qualifies this release before enabling enrollment.
export async function buildSharedSelectionPublication({ fetchSelection = fetchDiscoverySelection,
  heartbeat = async () => {} } = {}) {
  const fetched = await fetchSelection({ heartbeat });
  if (fetched.truncated || !fetched.items?.length) throw new Error('Complete Selection publication required');
  const rows = [];
  for (let index = 0; index < fetched.items.length; index += 500) {
    await heartbeat();
    rows.push(...await Promise.all(fetched.items.slice(index, index + 500).map(async item => {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.url))),
        byte => byte.toString(16).padStart(2, '0')).join('');
      return { item_type: 'live', external_id: item.tvgId || hash, parent_external_id: item.group || null,
        title: item.title, subtitle: item.group || null, poster_url: item.logo || null, backdrop_url: null,
        metadata: Object.fromEntries(Object.entries({ tvgId: item.tvgId, group: item.group }).filter(([,v]) => v !== undefined)),
        playback_hint: { sourceType: 'm3u', targetUrl: item.url }, available: true,
        ...discoveryCatalogFields(DISCOVERY_PLAYLIST_URL, item) };
    })));
  }
  const template = selectionTemplateRows(rows);
  // The same exact URL/id audit applies to episode files. Its unordered parent
  // language union is calculated by SQL; ordered maps stay on individual files.
  const files = await selectionSnapshotMovieManifests(template.filter(row => ['movie','episode'].includes(row.item_type))
    .map(row => ({ ...row, item_type: 'movie' })));
  const templateScope = '00000000-0000-4000-a000-000000000000';
  const plan = buildLiveMaterializationPlan({ userId: templateScope, sourceId: templateScope,
    rows: template.map(row => ({ ...row, source_id: templateScope })) });
  const privateFields = new Set(['id','user_id','source_id','sourceId','media_item_id','mediaItemId','synced_at']);
  const publicRow = value => Array.isArray(value) ? value.map(publicRow) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !privateFields.has(key)).map(([key,item]) => [key,publicRow(item)])) : value;
  return { builtAt: new Date().toISOString(), revision: await selectionPreparedRevision(),
    payload: { version: 1, rows: template, sources: fetched.sources || [], truncated: false, truncationReason: null }, files,
    live: { channels: plan.channelRows.map(publicRow), variants: plan.variantRows.map(publicRow) } };
}
