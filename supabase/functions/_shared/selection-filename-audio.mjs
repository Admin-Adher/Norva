// Filename declarations are catalogue hints, never observed or verified tracks.
// Only the media basename is inspected: titles, directories, query parameters
// and subtitles must not invent an audio language.
export const FILENAME_AUDIO_CODES = Object.freeze(['es', 'pt', 'fr', 'en', 'de', 'it', 'nl', 'ja', 'ko', 'zh', 'ar', 'ru', 'tr', 'hi', 'te', 'ta', 'ml', 'kn', 'bn', 'fil', 'id']);
const aliases = Object.freeze({
  es:'es', spa:'es', espanol:'es', spanish:'es', castellano:'es', latino:'es',
  pt:'pt', por:'pt', portugues:'pt', portuguese:'pt', 'pt-br':'pt',
  fr:'fr', fra:'fr', fre:'fr', vf:'fr', vff:'fr', vfq:'fr', francais:'fr', french:'fr',
  en:'en', eng:'en', english:'en', de:'de', deu:'de', ger:'de', deutsch:'de', german:'de',
  it:'it', ita:'it', italiano:'it', italian:'it', nl:'nl', nld:'nl', dut:'nl', dutch:'nl',
  ja:'ja', jpn:'ja', japanese:'ja', ko:'ko', kor:'ko', korean:'ko', zh:'zh', zho:'zh', chinese:'zh',
  ar:'ar', ara:'ar', arabic:'ar', ru:'ru', rus:'ru', russian:'ru', tr:'tr', tur:'tr', turkish:'tr',
  hi:'hi', hin:'hi', hindi:'hi', te:'te', telugu:'te', ta:'ta', tamil:'ta', ml:'ml', malayalam:'ml',
  kn:'kn', kannada:'kn', bn:'bn', bengali:'bn', fil:'fil', filipino:'fil', id:'id', indonesian:'id',
});
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const hex = /^[a-f0-9]{64}$/;
const feeds = new Set(['herbert-tested-vod', 'klysmgt-tested-vod', 'sandro-tested-vod']);

export function filenameAudioLanguage(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 12000) return null;
  let filename;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    // Object-storage keys may encode path separators as well as accented tags.
    filename = normalize(decodeURIComponent(url.pathname).split('/').pop());
  } catch { return null; }
  if (!filename || !/\.(?:mp4|mkv|avi|mov|webm|m4v|ts)$/i.test(filename)) return null;
  if (/(?:^|[^a-z])(?:subs?|subbed|subtitles?|subtit\w*|sous[ ._-]*tit\w*|legendad\w*|vost\w*|multi|dual)(?:[^a-z]|$)/.test(filename)) return null;
  const stem = filename.replace(/\.(?:mp4|mkv|avi|mov|webm|m4v|ts)$/, '').replace(/(?:_\d{1,2}|\(\d{1,2}\))$/, '').trim();
  // Bracketed markers and release suffixes are explicit. Short codes never
  // match ordinary words (e.g. "It", "Us", or "Johnny English").
  const bracketed = stem.match(/^(.*\S)[ ._-]*[\[(]([a-z-]+)[\])]$/);
  const separated = stem.match(/^(.*\S)(?:[._]|\s-\s)\s*([a-z-]+)$/);
  const bare = stem.match(/^(.*\S)\s+(espanol(?: latino)?|castellano|latino|portugues|francais)$/);
  const match = bracketed || separated || bare;
  if (!match || match[1].length < 2) return null;
  // Mixed language declarations require per-track evidence; avoid choosing
  // an arbitrary final marker from "Film.[EN].[FR]" or "Film.English.French".
  if (/[\[(](?:[a-z-]+)[\])]|(?:[._]|\s-\s)(?:english|french|spanish|portuguese|en|fr|es|pt)$/i.test(match[1])) return null;
  const marker = match[2] === 'espanol latino' ? 'espanol' : match[2];
  return Object.hasOwn(aliases, marker) ? aliases[marker] : null;
}

// Called only after the Selection import has validated the exact media URL.
export async function selectionFilenameAudioDeclaration(entry) {
  if (!feeds.has(entry?.feedId)) return null;
  const language = filenameAudioLanguage(entry.url);
  if (!language || !hex.test(entry.validation?.urlSha256 || '')) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entry.url));
  const urlSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (urlSha256 !== entry.validation.urlSha256) return null;
  return { version:1, language, urlSha256 };
}

export function storedFilenameAudioLanguage(metadata, externalId) {
  if (!/^norva-selection:movie:[a-f0-9]{64}$/.test(externalId || '')
      || metadata?.selectionRevision !== 'selection-vod-20260906-v1'
      || !feeds.has(metadata.discoveryFeed)) return null;
  const declaration = metadata.selectionFilenameAudio;
  if (declaration?.version !== 1 || !FILENAME_AUDIO_CODES.includes(declaration.language)
      || !hex.test(declaration.urlSha256 || '')
      || declaration.urlSha256 !== metadata.selectionPlaybackValidation?.urlSha256) return null;
  return declaration.language;
}
