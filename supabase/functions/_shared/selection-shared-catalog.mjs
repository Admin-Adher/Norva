import { DISCOVERY_PLAYLIST_URL, isDiscoverySourceId } from './discovery-catalog.mjs';
import { selectionPreparedRevision } from './selection-prepared-catalog.mjs';

const missing = error => ['42883', 'PGRST202'].includes(error?.code);

export async function activateSharedSelection({ db, userId, sourceId, config }) {
  // A client-editable display name or hint cannot enroll a different playlist.
  if (config?.playlistUrl !== DISCOVERY_PLAYLIST_URL || !await isDiscoverySourceId(sourceId, userId)) return false;
  const snapshot = await db.rpc('norva_get_catalog_write_snapshot', { p_source_id: sourceId, p_user_id: userId });
  if (snapshot.error) throw snapshot.error;
  const fence = snapshot.data;
  if (fence?.isCatalogVisible !== true || !fence.generationId) throw new Error('Selection enrollment is no longer visible');
  const result = await db.rpc('norva_activate_selection_shared_catalog', {
    p_source_id: sourceId, p_user_id: userId, p_revision: await selectionPreparedRevision(),
    p_generation_id: fence.generationId, p_head_revision: fence.headRevision, p_config_revision: fence.configRevision,
    p_source_visibility_epoch: fence.sourceVisibilityEpoch, p_user_visibility_epoch: fence.userVisibilityEpoch,
  });
  if (missing(result.error)) return false; // rolling schema deployment: ordinary import remains available
  if (result.error) throw result.error;
  return result.data?.activated === true;
}

export async function bindSharedSelectionFile({ db, userId, sourceId, itemType, itemId }) {
  if (!await isDiscoverySourceId(sourceId, userId)) return;
  const result = await db.rpc('norva_bind_selection_shared_file', {
    p_user_id: userId, p_source_id: sourceId, p_item_type: itemType, p_external_id: itemId,
  });
  if (missing(result.error)) return;
  if (result.error) throw result.error;
}
