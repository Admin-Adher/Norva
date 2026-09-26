// Owner-confirmed identity. Festival facts supplement missing TMDB fields;
// they are not represented as information returned by the TMDB API.
export const RETORNO_EDITORIAL = Object.freeze({
  tmdbId: '1745971',
  source: 'https://www.falasaochico.com.br/filme.php?id=11961',
  sourceName: 'FALA São Chico 2026',
  runtimeMinutes: 15,
  directors: ['Cesar Meneghetti', 'Mario Gianni'],
  cast: ['Mario Gianni', 'Habitants des villages yanomami de São Gabriel da Cachoeira'],
  country: 'BR',
  certification: { country: 'BR', value: 'Livre' },
  trailerUrl: 'https://vimeo.com/1136994188',
  overview: {
    fr: 'À 82 ans, le documentariste italien Mario Gianni entreprend un voyage de Rome à l’Amazonie. Quarante ans après sa première rencontre avec les Yanomami, il revient dans leur village pour tenir une promesse : y projeter le film qu’il leur a consacré.',
    en: 'At 82, Italian documentary filmmaker Mario Gianni travels from Rome to the Amazon. Forty years after first meeting the Yanomami, he returns to their village to fulfil a promise: to screen his film there.',
    pt: 'Aos 82 anos, o documentarista italiano Mario Gianni viaja de Roma à Amazônia. Quarenta anos depois do primeiro encontro com os Yanomami, retorna à aldeia para cumprir a promessa de exibir ali seu filme.',
  },
});

export function supplementSelectionEditorial(title) {
  if (String(title.provider_tmdb_id) !== RETORNO_EDITORIAL.tmdbId
      || !['manual', 'matched', 'provider_verified'].includes(title.match_status)) return title;
  const metadata = { ...(title.metadata || {}) }, tmdb = { ...(metadata.tmdb || {}) };
  const i18n = { ...(metadata.i18n || {}) };
  for (const [lang, overview] of Object.entries(RETORNO_EDITORIAL.overview)) {
    i18n[lang] = { ...(i18n[lang] || {}), overview: i18n[lang]?.overview || overview };
  }
  return { ...title, metadata: { ...metadata, i18n,
    runtime: metadata.runtime || RETORNO_EDITORIAL.runtimeMinutes,
    overview: metadata.overview || RETORNO_EDITORIAL.overview.pt,
    editorialSupplement: RETORNO_EDITORIAL,
    tmdb,
  } };
}

export function supplementSelectionExtras(value, url) {
  if (url.searchParams.get('type') === 'series' || url.searchParams.get('tmdbId') !== RETORNO_EDITORIAL.tmdbId) return value;
  const lang = (url.searchParams.get('lang') || 'en').slice(0, 2).toLowerCase();
  return { ...value, available: true,
    overview: value.overview || RETORNO_EDITORIAL.overview[lang] || RETORNO_EDITORIAL.overview.en,
    directors: value.directors?.length ? value.directors : RETORNO_EDITORIAL.directors,
    cast: value.cast?.length ? value.cast : RETORNO_EDITORIAL.cast.map(name => ({ name, character: '', profile: null })),
    editorialSource: RETORNO_EDITORIAL.source,
  };
}
