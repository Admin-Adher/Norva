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
          duration:entry.duration, codecProfile:profile });
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
    ...(entry.duration ? {duration:entry.duration} : {}), codecProfile:entry.codecProfile };
}

// Reuses the normal exact-file cache/fanout RPCs. No identity is invented for a
// public M3U source: each account retains its source-scoped key. Existing probes
// and speech verification win over this preparation snapshot on later imports.
export async function hydrateSelectionSnapshotMovieTracks({ db, userId, sourceId, rows, assertSourceCurrent = async()=>{} }) {
  if (sourceId !== await discoverySourceId(userId)) return {seeded:0};
  const files = await snapshot();
  const selected = rows.filter(r => r.item_type === 'movie' && files.get(r.external_id)?.url === r.playback_hint?.targetUrl);
  if (!selected.length) return {seeded:0};
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
  for(let offset=0;offset<pending.length;offset+=4) {
    await assertSourceCurrent();
    await Promise.all(pending.slice(offset,offset+4).map(async row=>{
      const tags=files.get(row.external_id);
      const args={p_server_host:key,p_item_type:'movie',p_external_id:row.external_id,p_audio_tracks:tags.audioTracks,
        p_subtitle_tracks:tags.subtitleTracks,p_has_audio:true,p_has_subtitle:tags.hasSubtitle};
      if(!cached.has(row.external_id)){
        const {error}=await db.rpc('upsert_catalog_file_tracks',args);if(error)throw error;
      }
      const fanout=await db.rpc('norva_fanout_file_tracks_to_users_fenced',args);if(fanout.error)throw fanout.error;
      seeded++;
    }));
    await assertSourceCurrent();
  }
  await assertSourceCurrent();
  return {seeded};
}
