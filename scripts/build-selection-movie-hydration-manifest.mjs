// Offline preparation only. No credentials, network request or database write.
// Input: {sources:[{userId,sourceId,generationFence,rows:[{id,item_type,external_id,playback_hint}]}]}.
// Rows must be the exact reviewed variant cohort, freshly read with current
// media ownership/URL and a norva_get_catalog_write_snapshot for each source.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDiscoverySourceId } from '../supabase/functions/_shared/discovery-catalog.mjs';
import { selectionSnapshotMovieManifests } from '../supabase/functions/_shared/selection-snapshot-tracks.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const revisions = ['p_head_revision','p_config_revision','p_source_visibility_epoch','p_user_visibility_epoch'];

export async function buildSelectionMovieHydrationManifest(input) {
  if (!Array.isArray(input?.sources) || !input.sources.length || input.sources.length > 100)
    throw Error('A bounded, freshly reviewed source cohort is required');
  const batches=[], seenSources=new Set(), seenVariants=new Set();
  let totalFiles=0;
  for (const source of input.sources) {
    const {userId,sourceId,generationFence,rows}=source;
    if (!uuid.test(userId) || !uuid.test(sourceId) || !await isDiscoverySourceId(sourceId,userId)
      || seenSources.has(sourceId)) throw Error('Invalid or duplicated canonical Selection ownership');
    if (!uuid.test(generationFence?.p_generation_id)
      || revisions.some(k=>!/^[0-9]+$/.test(String(generationFence[k]))))
      throw Error('All five current generation fences are required');
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
      throw Error('A source requires 1 to 1000 explicitly reviewed variants');
    for (const row of rows) {
      if (!uuid.test(row.id) || seenVariants.has(row.id)
        || (row.user_id && row.user_id!==userId) || (row.source_id && row.source_id!==sourceId)
        || (row.generation_id && row.generation_id!==generationFence.p_generation_id))
        throw Error('Variant ownership, generation or uniqueness failed');
      seenVariants.add(row.id);
    }
    const files=await selectionSnapshotMovieManifests(rows);
    if (files.length!==rows.length) throw Error('Every reviewed variant must match one complete immutable movie snapshot and exact URL');
    const fence=Object.fromEntries(['p_generation_id',...revisions].map(k=>[k,generationFence[k]]));
    const idByExternal=new Map(rows.map(row=>[row.external_id,row.id]));
    for (let offset=0;offset<files.length;offset+=50) {
      const part=files.slice(offset,offset+50);
      batches.push({rpc:'hydrate_selection_snapshot_movie_languages',
        variantIds:part.map(file=>idByExternal.get(file.externalId)),
        args:{p_user_id:userId,p_source_id:sourceId,...fence,p_files:part}});
    }
    totalFiles+=files.length;seenSources.add(sourceId);
  }
  return {generatedAt:new Date().toISOString(),dryRun:true,
    summary:{sources:seenSources.size,variants:seenVariants.size,files:totalFiles,batches:batches.length},batches};
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  if (args.length!==4 || args[0]!=='--input' || args[2]!=='--output' || !args[3].endsWith('.private.json'))
    throw Error('Usage: node scripts/build-selection-movie-hydration-manifest.mjs --input current-owned-rows.private.json --output repair.private.json');
  const output=await buildSelectionMovieHydrationManifest(JSON.parse(fs.readFileSync(args[1],'utf8')));
  fs.writeFileSync(args[3],JSON.stringify(output,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({dryRun:true,...output.summary}));
}
