import { isDiscoverySourceId } from './discovery-catalog.mjs';
import { selectionTemplateRows, selectionPreparedRevision } from './selection-prepared-catalog.mjs';

const titleFields = ['item_type','identity_key','identity_source','provider_tmdb_id','provider_imdb_id',
  'match_status','title','original_title','release_year','poster_url','backdrop_url','metadata','version_languages'];
const variantFields = ['item_type','external_id','raw_title','label','language','quality','resolution',
  'container_extension','poster_url','playback_hint','codec_profile','compatibility_tier','playback_cost_score','metadata'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]]));

export function selectionTitleRecipes(rows, titles, variants) {
  const byTitle = new Map(titles.map(title => [title.item_type+':'+title.identity_key,title]));
  const byFile = new Map(variants.map(variant => [variant.item_type+':'+variant.external_id,variant]));
  return selectionTemplateRows(rows).flatMap(raw => {
    const variant = byFile.get(raw.item_type+':'+raw.external_id);
    const title = variant && byTitle.get(raw.item_type+':'+variant.metadata?.identityKey);
    if (!title) return [];
    return [{raw,title:pick(title,titleFields),variant:pick(variant,variantFields)}];
  });
}

export async function saveSelectionTitleRecipes({db,sourceId,userId,rows,titles,variants}) {
  if (!await isDiscoverySourceId(sourceId,userId)) return;
  // Captured before persistence/hydration: these are provider/public catalogue
  // computations, never another owner's stored preferences or observations.
  const recipes = selectionTitleRecipes(rows,titles,variants);
  for (let offset=0;offset<recipes.length;offset+=500) {
    const {error}=await db.rpc('norva_cache_selection_title_recipes',{
      p_revision:await selectionPreparedRevision(),p_recipes:recipes.slice(offset,offset+500)});
    if (error) { console.warn('[selection] title recipe cache unavailable'); return; }
  }
}

export async function applySelectionTitleRecipes({db,sourceId,userId,rows,generationFence}) {
  if (!await isDiscoverySourceId(sourceId,userId) || rows.length>500) return null;
  const ids=rows.map(row=>row.id);
  if (!ids.length || ids.some(id=>typeof id!=='string')) return null;
  const {data,error}=await db.rpc('norva_apply_selection_title_recipes',{
    p_source_id:sourceId,p_user_id:userId,...generationFence,p_item_ids:ids,p_revision:await selectionPreparedRevision(),
  });
  if (error) {
    if (['42883','PGRST202'].includes(error.code)) return null;
    throw error; // ownership, integrity and statement failures are not cache misses
  }
  if (data?.reused!==true) return null;
  if (!Array.isArray(data.itemIds) || data.itemIds.length!==data.variants
    || new Set(data.itemIds).size!==data.itemIds.length || data.itemIds.some(id=>!ids.includes(id))) {
    throw new Error('Invalid Selection binding receipt');
  }
  return data;
}
