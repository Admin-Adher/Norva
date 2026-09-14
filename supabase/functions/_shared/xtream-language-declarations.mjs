// Keep explicit provider language fields for later, source-scoped interpretation.
// This is deliberately NOT a language resolver or an observed-track profile.
// Country, original-language and generic language fields never become audio.
const MAX_VALUE_LENGTH = 80;
const MAX_VALUES_PER_FIELD = 8;
const MAX_TRACKS_PER_FIELD = 16;
const MAX_DECLARATIONS = 32;
const MAX_BYTES = 8192;
const encoder = new TextEncoder();
const SCALAR_FIELDS = Object.freeze({
  audio: ['audio_language', 'audio_languages', 'audioLanguage', 'audioLanguages'],
  subtitle: ['subtitle_language', 'subtitle_languages', 'subtitleLanguage', 'subtitleLanguages'],
  unspecified: ['language', 'languages', 'lang', 'provider_language', 'providerLanguage', 'stream_language', 'streamLanguage'],
  original: ['original_language', 'original_languages', 'originalLanguage', 'originalLanguages'],
});
const TRACK_FIELDS = Object.freeze({
  audio: ['audio', 'audio_tracks', 'audioTracks'],
  subtitle: ['subtitles', 'subtitle_tracks', 'subtitleTracks'],
});
const TRACK_LANGUAGE_FIELDS = ['language', 'languages', 'language_code', 'languageCode', 'lang'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value, key) {
  return record(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function languageLabel(value) {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) return null;
  // Reject rather than truncate malformed values: slicing could change a label.
  // Permit ordinary language names/codes and lists, not URLs, HTML, identifiers,
  // free-form object dumps or credential-bearing strings from provider payloads.
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!text || !/^[\p{L}\p{M}][\p{L}\p{M}\p{N} ()\[\]/_,+|&-]*$/u.test(text)) return null;
  // Apply compatibility/camel-case normalization only to this rejection guard;
  // declarations keep their original NFC spelling. A word boundary by itself
  // misses access_token, clientSecret, user_name and full-width credential keys.
  const guard = text.normalize('NFKC');
  const guardWords = guard.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  if (/\b(?:password|passwd|user\s*name|authorization|bearer|secret|token|api\s*key)\b/iu.test(guardWords)) return null;
  // Opaque identifiers are not language declarations, including when embedded
  // in a list. Do not reject BCP-47 labels such as es-419 or ordinary names.
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu.test(guard)
    || /\b[0-9a-f]{24,}\b/iu.test(guardWords)) return null;
  return text;
}

/**
 * Preserve only bounded, allowlisted declarations under a non-operative key.
 * A provider response cannot supply evidence/certification flags or override
 * this envelope. Original/generic language fields are quarantined by role.
 * Returned values retain provider spelling; no aliases or audio inference occur.
 */
export function xtreamLanguageDeclarations(item) {
  if (!record(item)) return null;
  const result = { schemaVersion: 1, providerType: 'xtream', evidence: 'provider_declaration', declarations: [] };
  let truncated = false;
  const append = (field, role, value) => {
    if (value === undefined || value === null) return;
    const candidates = Array.isArray(value) ? value.slice(0, MAX_VALUES_PER_FIELD) : [value];
    if (Array.isArray(value) && value.length > MAX_VALUES_PER_FIELD) truncated = true;
    const values = [...new Set(candidates.map(languageLabel).filter(Boolean))];
    if (!values.length) return;
    if (result.declarations.length >= MAX_DECLARATIONS) { truncated = true; return; }
    const entry = { field, role, values };
    const candidate = { ...result, declarations: [...result.declarations, entry], truncated: true };
    if (encoder.encode(JSON.stringify(candidate)).length > MAX_BYTES) { truncated = true; return; }
    result.declarations.push(entry);
  };
  // Only documented envelope shapes; no recursive walk through arbitrary data.
  for (const [prefix, input] of [['', item], ['info.', own(item, 'info')], ['movie_data.', own(item, 'movie_data')]]) {
    if (!record(input)) continue;
    for (const [role, fields] of Object.entries(SCALAR_FIELDS)) {
      for (const field of fields) append(prefix + field, role, own(input, field));
    }
    for (const [role, fields] of Object.entries(TRACK_FIELDS)) {
      for (const field of fields) {
        const value = own(input, field);
        // A bare `audio: "aac"` is a codec, not a language declaration.
        const tracks = Array.isArray(value) ? value.slice(0, MAX_TRACKS_PER_FIELD) : record(value) ? [value] : [];
        if (Array.isArray(value) && value.length > MAX_TRACKS_PER_FIELD) truncated = true;
        for (let index = 0; index < tracks.length; index++) {
          const track = tracks[index];
          if (!record(track)) continue;
          const fieldPath = prefix + field + (Array.isArray(value) ? `[${index}]` : '');
          for (const key of TRACK_LANGUAGE_FIELDS) append(`${fieldPath}.${key}`, role, own(track, key));
          append(`${fieldPath}.tags.language`, role, own(own(track, 'tags'), 'language'));
          for (const key of ['LANGUAGE', 'lang', 'LANG']) {
            append(`${fieldPath}.tags.${key}`, role, own(own(track, 'tags'), key));
          }
        }
      }
    }
  }
  if (!result.declarations.length) return null;
  if (truncated) result.truncated = true;
  return result;
}
