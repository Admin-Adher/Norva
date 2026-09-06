import { curatedSelectionPlaylist } from './selection-curated-channels.mjs';
// Curated independently of user playlists. Additions require a playable full film,
// attribution and a source-specific redistribution licence; never scrape credentials.
export const DISCOVERY_PLAYLIST_URL = 'https://norva.tv/catalog/discovery.m3u';
// Reviewed channels and the two qualified VOD feeds are active. Retired feeds stay archived.
export const DISCOVERY_SELECTION_ENABLED = true;
export function assertDiscoverySelectionAvailable() {
  if (!DISCOVERY_SELECTION_ENABLED) throw new Error('Norva Selection is temporarily unavailable');
}
export function discoverySourceId(userId) { return selectionSourceIdentity('norva-selection-curated-v1:', userId); }
export function retiredDiscoverySourceId(userId) { return selectionSourceIdentity('norva-selection-v1:', userId); }
async function selectionSourceIdentity(prefix, userId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prefix + userId));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const DISCOVERY_FILMS = Object.freeze([
  { id: 'sintel', title: 'Sintel', year: 2010, archive: 'Sintel', file: 'sintel-2048-stereo.mp4', duration: 888, licence: '3.0', credit: 'Blender Foundation | durian.blender.org', rights: 'https://durian.blender.org/sharing/', plot: 'A young traveller searches for a dragon she once rescued.' },
  { id: 'big-buck-bunny', title: 'Big Buck Bunny', year: 2008, archive: 'BigBuckBunny_124', file: 'Content/big_buck_bunny_720p_surround.mp4', duration: 596, licence: '3.0', credit: 'Blender Foundation | www.bigbuckbunny.org', rights: 'https://peach.blender.org/about/', plot: 'A peaceful rabbit stands up to three mischievous forest animals.' },
  { id: 'elephants-dream', title: 'Elephants Dream', year: 2006, archive: 'ElephantsDream', file: 'ed_1024.mp4', duration: 654, licence: '2.5', credit: 'Blender Foundation / Netherlands Media Art Institute | orange.blender.org', rights: 'https://orange.blender.org/', plot: 'Two travellers explore a strange machine and disagree about what they see.' },
  { id: 'tears-of-steel', title: 'Tears of Steel', year: 2012, archive: 'Tears-of-Steel', file: 'tears_of_steel_1080p.mp4', duration: 734, licence: '3.0', credit: 'Blender Foundation | mango.blender.org', rights: 'https://mango.blender.org/sharing/', plot: 'In a future Amsterdam, a team tries to repair a mistake from the past.' },
  { id: 'cosmos-laundromat', title: 'Cosmos Laundromat: First Cycle', year: 2015, archive: 'CosmosLaundromatFirstCycle', file: 'Cosmos Laundromat - First Cycle (1080p).mp4', duration: 731, licence: '3.0', credit: 'Blender Foundation | gooseberry.blender.org', rights: 'https://gooseberry.blender.org/license/', plot: 'A mysterious visitor offers a sheep an unexpected chance at another life.' },
].map(film => Object.freeze({ ...film,
  url: `https://archive.org/download/${film.archive}/${film.file.split('/').map(encodeURIComponent).join('/')}`,
  poster: `https://archive.org/services/img/${film.archive}`,
  licenceUrl: `https://creativecommons.org/licenses/by/${film.licence}/`,
})));

export function discoveryMovieFields(playlistUrl, mediaUrl) {
  if (playlistUrl !== DISCOVERY_PLAYLIST_URL) return {};
  const film = DISCOVERY_FILMS.find(entry => entry.url === mediaUrl);
  if (!film) throw new Error('Unknown film in curated discovery playlist');
  return {
    item_type: 'movie', external_id: `norva-discovery:${film.id}`,
    title: film.title, parent_external_id: 'Norva Selection', subtitle: 'Norva Selection',
    poster_url: film.poster,
    metadata: { year: film.year, plot: `${film.plot}\n\n${film.credit} · CC BY ${film.licence}\n${film.licenceUrl}\nhttps://norva.tv/catalog/credits.html`, duration: film.duration, containerExtension: 'mp4', discoveryId: film.id, licence: film.licenceUrl, attribution: film.credit },
    playback_hint: { sourceType: 'm3u', targetUrl: film.url, containerExtension: 'mp4' },
  };
}

export function discoveryPlaylist() {
  return DISCOVERY_SELECTION_ENABLED ? curatedSelectionPlaylist() : '#EXTM3U\n';
}
