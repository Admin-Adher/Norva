import { isDiscoverySourceId } from './discovery-catalog.mjs';
import { SELECTION_TESTED_VOD_FEEDS, testedSelectionVodEntries } from './selection-tested-vod.mjs';
import { selectionVodIdentity, selectionVodExternalId, SELECTION_VOD_REVISION } from './selection-vod.mjs';

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
        result.set(id, { url:entry.url, feedId:entry.feedId, audioTracks, subtitleTracks, hasSubtitle, quality:entry.quality,
          audioLanguages:[...new Set(audioTracks.map(t=>t.lang).filter(Boolean))],
          subtitleLanguages:[...new Set(subtitleTracks.map(t=>t.lang).filter(Boolean))],
          duration:entry.duration, probedAt:entry.validation?.containerMetadataCheckedAt
            || (entry.validation?.containerAudioTags ? entry.validation.checkedAt : null), codecProfile:profile });
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
  return { audioTracks:entry.audioTracks.map(t=>({...t})), audioTracksScope:'file', audioLanguages:[...entry.audioLanguages],
    audioLanguagesScope:'file', audioLanguageValidationStatus:entry.audioLanguages.length ? 'probed' : 'pending',
    ...(entry.hasSubtitle ? { subtitleTracks:entry.subtitleTracks.map(t=>({...t})), subtitleTracksScope:'file',
      subtitleLanguages:[...entry.subtitleLanguages], subtitleLanguagesScope:'file' } : {}),
    ...(entry.quality ? {quality:entry.quality} : {}),
    ...(entry.duration ? {duration:entry.duration} : {}), codecProfile:{...entry.codecProfile, ...(entry.probedAt ? {probeSource:'selection-container-audit',probedAt:entry.probedAt} : {})} };
}

// The playback resolver already proved the current owned episode. Bind the
// immutable audit to both that physical file id and its resolved URL.
export async function selectionSnapshotPlaybackTags({userId,sourceId,itemId,targetUrl,itemType,db}) {
  if(!await isDiscoverySourceId(sourceId,userId))return {};
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

// Only the checked-in, individually measured snapshot can construct this input.
// Editable row metadata (including codecProfile/audioLanguages) is never read.
// The digest avoids passing physical URLs to repair manifests and RPC receipts.
export async function selectionSnapshotMovieManifests(rows) {
  const files = await snapshot(), result = new Map();
  for (const row of rows) {
    const file = files.get(row.external_id);
    if (row.item_type !== 'movie' || !file || file.url !== row.playback_hint?.targetUrl
      || !file.probedAt || !Number.isFinite(Date.parse(file.probedAt))) continue;
    const tracks = file.audioTracks;
    if (!tracks.length || tracks.some(t => !Number.isInteger(t.index) || t.index < 0
      || !t.lang || ['und', 'unknown', 'mul', 'zxx'].includes(t.lang))
      || new Set(tracks.map(t => t.index)).size !== tracks.length) continue;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.url));
    result.set(row.external_id, {
      externalId:row.external_id, urlSha256:Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join(''),
      revision:SELECTION_VOD_REVISION, feedId:file.feedId, probedAt:file.probedAt,
      audioTracks:tracks.map(t=>({...t})), subtitleTracks:file.subtitleTracks.map(t=>({...t})),
      hasSubtitle:file.hasSubtitle,
    });
  }
  return [...result.values()];
}

// One atomic, generation-fenced RPC seeds only absent cache/observation data.
// Read-then-upsert used to race a newer probe and mistake another file's
// observation for this movie. The database now performs exact-file checks and
// preserves even an explicitly unidentified later observation.
export async function hydrateSelectionSnapshotMovieTracks({ db, userId, sourceId, rows, generationFence, assertSourceCurrent = async()=>{} }) {
  if (!await isDiscoverySourceId(sourceId, userId)) return {seeded:0};
  const selected = await selectionSnapshotMovieManifests(rows);
  if (!selected.length) return {seeded:0};
  if (!generationFence?.p_generation_id) throw new Error('Selection track hydration requires a catalogue generation');
  let seeded=0;
  // Bodies stay bounded and the RPC does not enumerate unrelated source files.
  for (let offset=0;offset<selected.length;offset+=50) {
    await assertSourceCurrent();
    const {data,error}=await db.rpc('hydrate_selection_snapshot_movie_languages',{
      p_user_id:userId,p_source_id:sourceId,...generationFence,
      p_files:selected.slice(offset,offset+50),
    });
    if(error)throw error;
    seeded+=Number(data)||0;
    await assertSourceCurrent();
  }
  return {seeded};
}

// Series catalogue badges/facets use an unordered union of owned episode
// observations. The database validates the active parent/file binding and the
// audited media URL hash; ordered track maps remain attached to each episode.
export async function hydrateSelectionSnapshotSeriesTracks({ db, userId, sourceId, rows, generationFence, assertSourceCurrent = async()=>{} }) {
  if (!await isDiscoverySourceId(sourceId, userId)) return {seeded:0};
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
