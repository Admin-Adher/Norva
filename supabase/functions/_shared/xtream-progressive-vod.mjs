// UUID keyset pagination is safe only after all cinema discovery targets finish:
// new VOD rows must not be inserted behind the publication cursor.
export function cinemaInventoryIsStable(cursor = {}) {
  if (cursor.v < 2 || cursor.order !== 'cinema_first' || !cursor.cats || !cursor.runVersion) return false;
  const laneSize = (lane) => Math.max(1, Array.isArray(cursor.cats[lane]) ? cursor.cats[lane].length : 0);
  return Number(cursor.walkIdx || 0) >= laneSize('movie') + laneSize('series');
}

export function cinemaPublicationState(cursor, generationId) {
  const identity = `${generationId}:${cursor.runVersion}:${cursor.startedAt}`;
  const previous = cursor.cinemaPublication;
  return previous?.identity === identity ? { ...previous } : {
    identity, afterId: '', movies: 0, series: 0, complete: false,
  };
}

// Checkpoint only successfully projected pages. Retry reuses normal idempotent
// title/variant upserts, and never advances beyond a partially failed write.
export async function publishCinemaPages({ state, load, project, checkpoint, deadline, now = Date.now, limit = 250 }) {
  while (!state.complete && now() < deadline) {
    const rows = await load(state.afterId, limit);
    if (rows.length) {
      await project(rows);
      state = {
        ...state,
        afterId: String(rows[rows.length - 1].id),
        movies: state.movies + rows.filter(row => row.item_type === 'movie').length,
        series: state.series + rows.filter(row => row.item_type === 'series').length,
      };
    }
    state = { ...state, complete: rows.length < limit };
    if (await checkpoint(state) === false) return { ...state, superseded: true };
  }
  return state;
}
