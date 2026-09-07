// Offline catalogue preparation: container declarations are never inferred from
// the title, the playlist country, or TMDB's original_language.
const aliases = Object.freeze({spa:'es',por:'pt',eng:'en',fra:'fr',fre:'fr',deu:'de',ger:'de',ita:'it',jpn:'ja',kor:'ko',zho:'zh',chi:'zh',hin:'hi',tam:'ta',tel:'te',mal:'ml',kan:'kn',rus:'ru',ara:'ar',tur:'tr',pol:'pl',nld:'nl',dut:'nl',dan:'da',swe:'sv',nor:'no',fin:'fi',isl:'is',ice:'is',lat:'la',tha:'th',vie:'vi',ind:'id',ukr:'uk',ron:'ro',rum:'ro',ces:'cs',cze:'cs',ell:'el',gre:'el',hun:'hu',heb:'he',fas:'fa',per:'fa',ben:'bn',cat:'ca',eus:'eu',baq:'eu'});
const codes = new Set(Object.values(aliases));
export function selectionContainerLanguage(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return aliases[raw] || (codes.has(raw) ? raw : null);
}
export function selectionContainerTags(probe, { heldLanguageCodes = [] } = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find(s => s.codec_type === 'video' && s.width > 0 && s.height > 0);
  if (!video) return null;
  const blocked = new Set(heldLanguageCodes);
  const language = s => blocked.has(s.tags?.language) ? null : selectionContainerLanguage(s.tags?.language);
  const tracks = kind => streams.filter(s => s.codec_type === kind && Number.isInteger(s.index) && s.index >= 0).map(s => ({
    index:s.index, codec:s.codec_name || null, ...(kind === 'audio' && s.channels ? {channels:s.channels} : {}), language:language(s),
  }));
  const audioTracks = tracks('audio'), subtitleTracks = tracks('subtitle');
  const duration = Number(probe.format?.duration);
  const quality = video.width >= 3800 || video.height >= 2100 ? '4K' : video.width >= 1900 || video.height >= 1080 ? 'FHD' : video.width >= 1200 || video.height >= 720 ? 'HD' : 'SD';
  return {
    audioLanguages:[...new Set(audioTracks.map(t=>t.language).filter(Boolean))],
    subtitleLanguages:[...new Set(subtitleTracks.map(t=>t.language).filter(Boolean))],
    quality,
    ...(Number.isFinite(duration) && duration > 0 ? {duration} : {}),
    codecProfile:{videoCodec:video.codec_name || null, audioCodec:audioTracks[0]?.codec || null,videoWidth:video.width,videoHeight:video.height,
      ...(Number.isFinite(duration) && duration > 0 ? {durationSeconds:duration} : {}), audioTracks, subtitleTracks},
  };
}
