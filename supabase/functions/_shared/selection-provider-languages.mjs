import { FILENAME_AUDIO_CODES, storedFilenameAudioLanguage } from './selection-filename-audio.mjs';
import { providerCatalogLanguage, PROVIDER_CATALOG_LANGUAGES } from './provider-catalog-language.mjs';
// Supplier catalogue declarations are hints, never observed tracks or speech proof.
const LANGUAGES = Object.freeze({ Telugu: 'te', Tamil: 'ta', Malayalam: 'ml', Hindi: 'hi', Kannada: 'kn', English: 'en' });
const CODES = new Set([...Object.values(LANGUAGES), ...FILENAME_AUDIO_CODES, ...PROVIDER_CATALOG_LANGUAGES]);

export function providerAudioFacet(value) {
  const match = /^(?:provider|catalog)-([a-z]{2,3}|nordic)$/.exec(String(value || '').trim().toLowerCase());
  return match && (CODES.has(match[1]) || (/^[a-z]{2}$/.test(match[1]) && match[1] !== 'un')) ? (match[1] === 'fil' ? 'tl' : match[1]) : null;
}

// Query/display declarations only. Exact observed tracks remain independent.
export function catalogProviderAudioLanguages(item = {}) {
  const selection = selectionProviderAudioLanguages(item);
  if (selection.length) return selection;
  const hint = providerCatalogLanguage(item);
  return hint ? [hint] : [];
}

export function catalogVariantMatchesAudio(variant, facet, canonicalize = value => value) {
  const language = providerAudioFacet(facet);
  if (!language) return false;
  const tracks = Array.isArray(variant.__file_audio_tracks) ? variant.__file_audio_tracks : [];
  const observed = Array.isArray(variant.__file_audio_languages) ? variant.__file_audio_languages : [];
  const actual = [...observed, ...tracks.map(track => track?.lang ?? track?.language)]
    .map(value => value === 'yue' ? value : canonicalize(value)).filter(value => value && !['und','un','unknown'].includes(value));
  if (actual.length) return actual.includes(language);
  // Empty language observations are inconclusive, not evidence of silence.
  if (variant.__file_audio_probed_at && Array.isArray(variant.__file_audio_tracks) && !tracks.length) return false;
  return catalogProviderAudioLanguages(variant).some(value => (value === 'fil' ? 'tl' : value) === language);
}

export function selectionProviderAudioLanguages(item = {}) {
  const metadata = item.metadata || {};
  const id = item.external_id || item.externalId || item.item_id || item.itemId || '';
  const filenameLanguage = storedFilenameAudioLanguage(metadata, id);
  if (filenameLanguage) return [filenameLanguage];
  if (!/^norva-selection:(?:movie|series):[a-f0-9]{64}$/.test(id)
      || metadata.selectionRevision !== 'selection-vod-20260906-v1'
      || metadata.discoveryFeed !== 'babuperumana-vod') return [];
  const match = /^Movies \/ (Telugu|Tamil|Malayalam|Hindi|Kannada|English)(?: \/ (?:19|20)\d{2})?$/.exec(metadata.selectionVodGroup || '');
  return match ? [LANGUAGES[match[1]]] : [];
}

export function publicProviderAudioLanguages(item = {}) {
  const derived = selectionProviderAudioLanguages(item);
  if (derived.length) return derived;
  // Preserve this explicit public field through repeated catalog sanitization.
  if ((item.provider_audio_language_status || item.providerAudioLanguageStatus) !== 'provider_declared') return [];
  const values = item.provider_audio_languages || item.providerAudioLanguages;
  return Array.isArray(values) ? [...new Set(values.filter(value => CODES.has(value)))] : [];
}
