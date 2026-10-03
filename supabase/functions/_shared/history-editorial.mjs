const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const key = (source, type, id) => JSON.stringify([source, type, id]);

// Refresh display information at read time. History remains the authority for
// position, duration, chronology, profile and the exact provider playback target.
export async function refreshHistoryEditorial(rows, { db, userId, epoch, lang }) {
  if (!epoch || !rows.length) return rows;
  try {
    const groups = new Map();
    const targets = new Map();
    for (const row of rows) {
      const data = record(row.data);
      const type = row.item_type === 'episode' ? 'series' : row.item_type;
      const id = type === 'series' ? text(data.seriesId ?? data.series_id) : text(row.item_id);
      if (!row.source_id || !id || !['movie', 'series'].includes(type)) continue;
      const groupKey = key(row.source_id, type, '');
      if (!groups.has(groupKey)) groups.set(groupKey, { source: row.source_id, type, ids: new Set() });
      groups.get(groupKey).ids.add(id);
      targets.set(row, key(row.source_id, type, id));
    }
    const variantsByKey = new Map();
    for (const { source, type, ids } of groups.values()) {
      const all = [...ids];
      for (let offset = 0; offset < all.length; offset += 100) {
        const { data, error } = await db.from('cloud_catalog_visible_title_variants')
          .select('title_id,source_id,item_type,external_id,generation_id')
          .eq('user_id', userId).eq('source_id', source).eq('item_type', type)
          .in('external_id', all.slice(offset, offset + 100));
        if (error) throw error;
        for (const variant of data ?? []) {
          if (variant.source_id !== source || variant.item_type !== type || !ids.has(variant.external_id)) continue;
          const k = key(source, type, variant.external_id);
          variantsByKey.set(k, [...(variantsByKey.get(k) ?? []), variant]);
        }
      }
    }
    const ids = [...new Set([...variantsByKey.values()].filter(v => v.length === 1).map(v => v[0].title_id))];
    const titles = new Map();
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const { data, error } = await db.rpc('norva_get_visible_catalog_titles_by_ids', {
        p_user_id: userId, p_title_ids: chunk, p_expected_visibility_epoch: epoch,
      });
      if (error || data?.contract !== 'catalog-title-hydration-v3' || String(data.visibilityEpoch) !== String(epoch)
          || !Array.isArray(data.items)) throw Error('History editorial snapshot unavailable');
      for (const title of data.items) {
        if (title.user_id !== userId || !chunk.includes(title.id) || titles.has(title.id)) throw Error('Invalid history title owner');
        titles.set(title.id, title);
      }
    }
    return rows.map(row => {
      const variants = variantsByKey.get(targets.get(row));
      if (variants?.length !== 1) return row;
      const variant = variants[0], title = titles.get(variant.title_id);
      if (!title || !title.visible_source_ids?.includes(row.source_id)
          || !['matched', 'manual', 'provider_verified'].includes(title.match_status)) return row;
      if (title.overlay_generation_id && title.overlay_generation_id === title.display_generation_id
          && title.display_generation_id !== variant.generation_id) return row;
      const metadata = record(title.metadata), loc = record(record(metadata.i18n)[lang]);
      const name = text(loc.title) ?? text(title.title);
      const poster = text(title.poster_url), backdrop = text(title.backdrop_url);
      const data = { ...record(row.data) };
      if (name) data.title = name;
      if (poster) Object.assign(data, { poster, posterUrl: poster, poster_url: poster });
      if (backdrop) Object.assign(data, { backdrop, backdropUrl: backdrop, backdrop_url: backdrop });
      // Only presentation fields are refreshed. The owned variant above remains
      // the proof for this exact source; editorial metadata is never audio proof.
      const tmdb = record(metadata.tmdb);
      const description = text(loc.overview) ?? text(tmdb.overview)
        ?? text(metadata.overview) ?? text(metadata.plot);
      if (description) Object.assign(data, { description, overview: description, plot: description });
      const year = Number(title.release_year);
      if (Number.isInteger(year) && year >= 1800 && year <= 2200) data.year = year;
      const rating = title.rating_num ?? tmdb.vote_average;
      if (rating != null && Number.isFinite(Number(rating)) && Number(rating) >= 0 && Number(rating) <= 10)
        data.rating = Number(rating);
      const genres = metadata.genres ?? tmdb.genres;
      if (Array.isArray(genres) && genres.length) data.genres = genres;
      return { ...row, ...(name ? { item_name: name } : {}), data };
    });
  } catch { return rows; } // Transient metadata failures must never erase resume state.
}
