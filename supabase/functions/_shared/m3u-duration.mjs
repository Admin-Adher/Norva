// EXTINF is a catalogue timeline hint, never codec or media-kind evidence.
// Keep the existing finite-VOD gateway limit (24 hours); reject coercible
// objects, units, non-decimal notation, non-finite and non-positive values.
export function m3uDurationSeconds(value) {
  if (typeof value === 'string') {
    const token = value.trim();
    if (token.length > 32 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) return null;
    value = Number(token);
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86_400
    ? value : null;
}
