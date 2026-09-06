// Supplier catalogue declarations are hints, never observed tracks or speech proof.
const LANGUAGES = Object.freeze({ Telugu: 'te', Tamil: 'ta', Malayalam: 'ml', Hindi: 'hi', Kannada: 'kn', English: 'en' });
const CODES = new Set(Object.values(LANGUAGES));

export function providerAudioFacet(value) {
  const match = /^(?:provider|catalog)-(te|ta|ml|hi|kn|en)$/.exec(String(value || '').trim().toLowerCase());
  return match ? match[1] : null;
}

export function selectionProviderAudioLanguages(item = {}) {
  const metadata = item.metadata || {};
  const id = item.external_id || item.externalId || item.item_id || item.itemId || '';
  if (!/^norva-selection:movie:[a-f0-9]{64}$/.test(id)
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
