import { discoverySourceId } from './discovery-catalog.mjs';
import { SELECTION_TESTED_VOD_FEEDS, testedSelectionVodEntries } from './selection-tested-vod.mjs';
import { selectionVodIdentity, selectionVodExternalId } from './selection-vod.mjs';

let snapshotPromise;
function snapshot() {
  if (!snapshotPromise) snapshotPromise = (async () => {
    const result = new Map();
    const entries = SELECTION_TESTED_VOD_FEEDS.flatMap(feed => testedSelectionVodEntries(feed.id));
    for (let offset = 0; offset < entries.length; offset += 250) {
      await Promise.all(entries.slice(offset, offset + 250).map(async entry => {
        const profile = entry.codecProfile;
        if (!Array.isArray(profile?.audioTracks) || !profile.audioTracks.length) return;
        const id = selectionVodExternalId(await selectionVodIdentity(entry.feedId, entry));
        const audioTracks = profile.audioTracks.map(t => ({ index:t.index, lang:t.language || null, codec:t.codec || null }));
        const hasSubtitle = Array.isArray(profile.subtitleTracks);
        const subtitleTracks = hasSubtitle ? profile.subtitleTracks.map(t => ({ index:t.index, lang:t.language || null,
          codec:t.codec || null, extractable:['subrip','srt','ass','ssa','webvtt','mov_text','text'].includes(t.codec) })) : [];
        result.set(id, { url:entry.url, audioTracks, subtitleTracks, hasSubtitle, quality:entry.quality,
          audioLanguages:[...new Set(audioTracks.map(t=>t.lang).filter(Boolean))],
          subtitleLanguages:[...new Set(subtitleTracks.map(t=>t.lang).filter(Boolean))],
          duration:entry.duration, probedAt:entry.validation?.containerMetadataCheckedAt, codecProfile:profile });
      }));
    }
    return result;
  })();
  return snapshotPromise;
}

// Called only after canonical Selection ownership/generation has been checked.
// The response comes from the audited server snapshot, never editable metadata.
export async function selectionSnapshotFileTags(externalId) {
  const entry = (await snapshot()).get(externalId);
  if (!entry) return {};
  return { audioTracks:entry.audioTracks, audioTracksScope:'file', audioLanguages:entry.audioLanguages,
    audioLanguagesScope:'file', audioLanguageValidationStatus:entry.audioLanguages.length ? 'probed' : 'pending',
    ...(entry.hasSubtitle ? { subtitleTracks:entry.subtitleTracks, subtitleTracksScope:'file',
      subtitleLanguages:entry.subtitleLanguages, subtitleLanguagesScope:'file' } : {}),
    ...(entry.quality ? {quality:entry.quality} : {}),
    ...(entry.duration ? {duration:entry.duration} : {}), codecProfile:{...entry.codecProfile, ...(entry.probedAt ? {probeSource:'selection-container-audit',probedAt:entry.probedAt} : {})} };
}

// The playback resolver already proved the current owned episode. Bind the
// immutable audit to both that physical file id and its resolved URL.
export async function selectionSnapshotPlaybackTags({userId,sourceId,itemId,targetUrl,itemType,db}) {
  if(sourceId!==await discoverySourceId(userId))return {};
  const file=(await snapshot()).get(itemId);
  if(!file||file.url!==targetUrl)return {};
  const tags=await selectionSnapshotFileTags(itemId);
  if(itemType!=='movie'||!db)return tags;
  // Later exact-file probes and speech verification outrank the static audit.
  const result=await db.from('catalog_file_tracks')
    .select('audio_tracks,subtitle_tracks,audio_probed_at,subtitle_probed_at,audio_lang_verified_at,audio_lang_verification')
    .eq('server_host','source:'+sourceId).eq('item_type','movie').eq('external_id',itemId).maybeSingle();
  if(result.error)return {};
  const cached=result.data;if(!cached)return tags;
  if(cached.audio_probed_at){
    const audioTracks=(Array.isArray(cached.audio_tracks)?cached.audio_tracks:[])
      .filter(t=>Number.isInteger(t.index)).map(t=>({index:t.index,lang:t.lang||null,language:t.lang||null}));
    tags.audioTracks=audioTracks;
    tags.audioLanguages=[...new Set(audioTracks.map(t=>t.lang).filter(Boolean))];
    tags.audioLanguageValidationStatus=cached.audio_lang_verified_at&&tags.audioLanguages.length?'verified':tags.audioLanguages.length?'probed':'pending';
    tags.audioLanguageVerifiedAt=cached.audio_lang_verified_at||null;
    tags.audioLanguageVerification=cached.audio_lang_verification||{};
    tags.codecProfile={...tags.codecProfile,audioTracks};
  }
  if(cached.subtitle_probed_at){
    tags.subtitleTracks=Array.isArray(cached.subtitle_tracks)?cached.subtitle_tracks:[];
    tags.subtitleLanguages=[...new Set(tags.subtitleTracks.map(t=>t.lang).filter(Boolean))];
    tags.subtitleTracksScope='file';tags.subtitleLanguagesScope='file';
    tags.codecProfile={...tags.codecProfile,subtitleTracks:tags.subtitleTracks};
  }
  return tags;
}

// Reuses the normal exact-file cache/fanout RPCs. No identity is invented for a
// public M3U source: each account retains its source-scoped key. Existing probes
// and speech verification win over this preparation snapshot on later imports.
export async function hydrateSelectionSnapshotMovieTracks({ db, userId, sourceId, rows, generationFence, assertSourceCurrent = async()=>{} }) {
  if (sourceId !== await discoverySourceId(userId)) return {seeded:0};
  const files = await snapshot();
  const selected = rows.filter(r => r.item_type === 'movie' && files.get(r.external_id)?.url === r.playback_hint?.targetUrl);
  if (!selected.length) return {seeded:0};
  if (!generationFence?.p_generation_id) throw new Error('Selection track hydration requires a catalogue generation');
  const key = `source:${sourceId}`, cached = new Set(), observed = new Set();
  // Selection IDs are long hashes: 50 keep PostgREST request URIs below 8 KiB.
  for (let offset=0;offset<selected.length;offset+=50) {
    await assertSourceCurrent();
    const {data,error}=await db.from('catalog_file_tracks').select('external_id,audio_probed_at,subtitle_probed_at')
      .eq('server_host',key).eq('item_type','movie').in('external_id',selected.slice(offset,offset+50).map(r=>r.external_id));
    if(error)throw error;
    for(const row of data||[])if(row.audio_probed_at)cached.add(row.external_id);
    const variants=await db.from('cloud_catalog_visible_title_variants').select('id,external_id')
      .eq('user_id',userId).eq('source_id',sourceId).eq('item_type','movie').in('external_id',selected.slice(offset,offset+50).map(r=>r.external_id));
    if(variants.error)throw variants.error;
    if(variants.data?.length){
      const observations=await db.from('cloud_title_file_language_observations').select('variant_id,audio_observed')
        .eq('user_id',userId).in('variant_id',variants.data.map(r=>r.id));
      if(observations.error)throw observations.error;
      const done=new Set((observations.data||[]).filter(r=>r.audio_observed).map(r=>r.variant_id));
      for(const row of variants.data)if(done.has(row.id))observed.add(row.external_id);
    }
  }
  let seeded=0;
  const pending=selected.filter(row=>!cached.has(row.external_id)||!observed.has(row.external_id));
  for(let offset=0;offset<pending.length;offset+=50) {
    const batch=pending.slice(offset,offset+50);
    for(let index=0;index<batch.length;index+=4) {
      await assertSourceCurrent();
      await Promise.all(batch.slice(index,index+4).map(async row=>{
        if(cached.has(row.external_id))return;
        const tags=files.get(row.external_id);
        const {error}=await db.rpc('upsert_catalog_file_tracks',{
          p_server_host:key,p_item_type:'movie',p_external_id:row.external_id,p_audio_tracks:tags.audioTracks,
          p_subtitle_tracks:tags.subtitleTracks,p_has_audio:true,p_has_subtitle:tags.hasSubtitle,
        });
        if(error)throw error;
      }));
      await assertSourceCurrent();
    }
    // Use the normal generation-fenced bulk join: one ownership proof and one
    // language-union recomputation per title, rather than per-file fanout calls.
    const hydrated=await db.rpc('hydrate_cloud_title_file_languages',{
      p_user_id:userId,p_source_id:sourceId,...generationFence,
      p_server_key:key,p_item_type:'movie',p_external_ids:batch.map(row=>row.external_id),
    });
    if(hydrated.error)throw hydrated.error;
    seeded+=batch.length;
    await assertSourceCurrent();
  }
  await assertSourceCurrent();
  return {seeded};
}

// Series catalogue badges/facets use an unordered union of owned episode
// observations. The database validates the active parent/file binding and the
// audited media URL hash; ordered track maps remain attached to each episode.
export async function hydrateSelectionSnapshotSeriesTracks({ db, userId, sourceId, rows, generationFence, assertSourceCurrent = async()=>{} }) {
  if (sourceId !== await discoverySourceId(userId)) return {seeded:0};
  const parentIds = [...new Set(rows.filter(row => row.item_type === 'series'
    && row.metadata?.seriesDelivery === 'selection'
    && /^norva-selection:series:[a-f0-9]{64}$/.test(row.external_id)).map(row => row.external_id))];
  if (!parentIds.length) return {seeded:0};
  if (!generationFence?.p_generation_id) throw new Error('Selection series hydration requires a catalogue generation');
  let seeded = 0;
  for (let offset=0; offset<parentIds.length; offset+=50) {
    await assertSourceCurrent();
    const {data,error} = await db.rpc('hydrate_selection_episode_file_languages', {
      p_user_id:userId,p_source_id:sourceId,...generationFence,
      p_parent_series_ids:parentIds.slice(offset,offset+50),
    });
    if (error) throw error;
    seeded += Number(data) || 0;
    await assertSourceCurrent();
  }
  return {seeded};
}
