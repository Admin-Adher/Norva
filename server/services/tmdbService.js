/**
 * TMDB Enrichment Service
 *
 * Matches movies/series against The Movie Database (title + year search)
 * and stores normalized metadata (genres, runtime, overview, poster,
 * vote average) on playlist_items. Lookups are cached per dedup_key so
 * duplicates across sources/categories cost a single API call.
 *
 * Requires settings.tmdbApiKey (v3 API key or v4 read access token).
 */

const { getDb } = require('../db/sqlite');
const { settings } = require('../db');
const { normalizeTitle, extractYear } = require('./mediaNormalizer');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const REQUEST_DELAY_MS = 120; // ~8 req/s, well under TMDB's limit

const state = {
    running: false,
    cancelRequested: false,
    total: 0,
    processed: 0,
    matched: 0,
    failed: 0,
    startedAt: null,
    finishedAt: null,
    lastError: null
};

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildAuth(apiKey) {
    // v4 read access tokens are JWTs ("ey..."), v3 keys are 32-char hex
    if (apiKey.startsWith('ey')) {
        return { headers: { Authorization: `Bearer ${apiKey}` }, queryKey: null };
    }
    return { headers: {}, queryKey: apiKey };
}

async function tmdbFetch(apiKey, endpoint, params = {}) {
    const auth = buildAuth(apiKey);
    const url = new URL(TMDB_BASE + endpoint);
    for (const [k, v] of Object.entries(params)) {
        if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
    }
    if (auth.queryKey) url.searchParams.set('api_key', auth.queryKey);

    const res = await fetch(url, { headers: auth.headers });
    if (res.status === 429) {
        // Rate limited: wait and retry once
        const retryAfter = parseInt(res.headers.get('retry-after')) || 2;
        await delay(retryAfter * 1000);
        const retry = await fetch(url, { headers: auth.headers });
        if (!retry.ok) throw new Error(`TMDB ${retry.status}`);
        return retry.json();
    }
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    return res.json();
}

/**
 * Search + fetch details for one title. Returns normalized data or null.
 */
async function lookupTitle(apiKey, type, title, year) {
    const isMovie = type === 'movie';
    const searchEndpoint = isMovie ? '/search/movie' : '/search/tv';
    const params = { query: title, include_adult: 'false' };
    if (year) {
        if (isMovie) params.primary_release_year = year;
        else params.first_air_date_year = year;
    }

    let search = await tmdbFetch(apiKey, searchEndpoint, params);

    // Retry without year constraint when nothing matches (provider years are often wrong)
    if ((!search.results || search.results.length === 0) && year) {
        delete params.primary_release_year;
        delete params.first_air_date_year;
        search = await tmdbFetch(apiKey, searchEndpoint, params);
    }

    const hit = search.results && search.results[0];
    if (!hit) return null;

    await delay(REQUEST_DELAY_MS);
    const details = await tmdbFetch(apiKey, isMovie ? `/movie/${hit.id}` : `/tv/${hit.id}`);

    return {
        id: details.id,
        title: isMovie ? details.title : details.name,
        original_title: isMovie ? details.original_title : details.original_name,
        genres: (details.genres || []).map(g => g.name),
        runtime: isMovie
            ? (details.runtime || null)
            : ((details.episode_run_time && details.episode_run_time[0]) || null),
        overview: details.overview || null,
        poster_path: details.poster_path || null,
        backdrop_path: details.backdrop_path || null,
        vote_average: details.vote_average || null,
        release_date: isMovie ? (details.release_date || null) : (details.first_air_date || null),
        original_language: details.original_language || null,
        status: details.status || null,
        in_production: !isMovie ? !!details.in_production : undefined,
        number_of_seasons: !isMovie ? (details.number_of_seasons || null) : undefined
    };
}

/**
 * Start (or resume) background enrichment of all un-enriched items.
 * Safe to call repeatedly — only one run at a time.
 */
async function startEnrichment() {
    if (state.running) {
        return { started: false, reason: 'already-running' };
    }

    const currentSettings = await settings.get();
    const apiKey = (currentSettings.tmdbApiKey || '').trim();
    if (!apiKey) {
        return { started: false, reason: 'no-api-key' };
    }

    state.running = true;
    state.cancelRequested = false;
    state.processed = 0;
    state.matched = 0;
    state.failed = 0;
    state.startedAt = Date.now();
    state.finishedAt = null;
    state.lastError = null;

    // Run in background, return immediately
    runEnrichment(apiKey).catch(err => {
        console.error('[TMDB] Enrichment crashed:', err);
        state.lastError = err.message;
    }).finally(() => {
        state.running = false;
        state.finishedAt = Date.now();
    });

    return { started: true };
}

async function runEnrichment(apiKey) {
    const db = getDb();

    // Distinct un-enriched keys, with a representative name/year for searching
    const pending = db.prepare(`
        SELECT type, dedup_key, MIN(name) AS name, MAX(year) AS year
        FROM playlist_items
        WHERE type IN ('movie', 'series')
          AND dedup_key IS NOT NULL
          AND tmdb_data IS NULL
        GROUP BY type, dedup_key
    `).all();

    state.total = pending.length;
    if (pending.length === 0) {
        console.log('[TMDB] Nothing to enrich');
        return;
    }
    console.log(`[TMDB] Starting enrichment of ${pending.length} unique titles...`);

    const getCache = db.prepare('SELECT tmdb_id, data FROM tmdb_cache WHERE dedup_key = ? AND type = ?');
    const setCache = db.prepare(`
        INSERT INTO tmdb_cache (dedup_key, type, tmdb_id, data, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key, type) DO UPDATE SET
            tmdb_id = excluded.tmdb_id,
            data = excluded.data,
            updated_at = excluded.updated_at
    `);
    const applyToItems = db.prepare(`
        UPDATE playlist_items SET tmdb_id = ?, tmdb_data = ?
        WHERE type = ? AND dedup_key = ?
    `);

    for (const row of pending) {
        if (state.cancelRequested) {
            console.log('[TMDB] Enrichment cancelled');
            return;
        }

        try {
            // Cache hit (e.g. previous run, or another source's duplicate)
            const cached = getCache.get(row.dedup_key, row.type);
            if (cached) {
                applyToItems.run(cached.tmdb_id, cached.data || JSON.stringify({ matched: false }), row.type, row.dedup_key);
                if (cached.tmdb_id) state.matched++;
                state.processed++;
                continue;
            }

            const title = row.dedup_key.split('|')[0];
            const year = row.dedup_key.split('|')[1] || extractYear(row.name, row.year);

            const data = await lookupTitle(apiKey, row.type, title || normalizeTitle(row.name), year);
            await delay(REQUEST_DELAY_MS);

            if (data) {
                const json = JSON.stringify({ matched: true, ...data });
                setCache.run(row.dedup_key, row.type, data.id, json, Date.now());
                applyToItems.run(data.id, json, row.type, row.dedup_key);
                state.matched++;
            } else {
                // Remember "no match" so we don't retry every run
                const json = JSON.stringify({ matched: false });
                setCache.run(row.dedup_key, row.type, null, json, Date.now());
                applyToItems.run(null, json, row.type, row.dedup_key);
            }
        } catch (err) {
            state.failed++;
            state.lastError = err.message;
            // Auth errors are fatal — stop instead of hammering the API
            if (err.message.includes('401') || err.message.includes('403')) {
                console.error('[TMDB] API key rejected, stopping enrichment');
                return;
            }
        }

        state.processed++;
        if (state.processed % 100 === 0) {
            console.log(`[TMDB] Enriched ${state.processed}/${state.total} (${state.matched} matched)`);
        }
    }

    console.log(`[TMDB] Enrichment done: ${state.matched}/${state.total} matched, ${state.failed} errors`);
}

function getStatus() {
    return { ...state };
}

function cancel() {
    state.cancelRequested = true;
}

/**
 * Clear stored TMDB data (forces full re-enrichment on next run)
 */
function reset() {
    const db = getDb();
    db.prepare(`UPDATE playlist_items SET tmdb_id = NULL, tmdb_data = NULL WHERE type IN ('movie','series')`).run();
    db.prepare('DELETE FROM tmdb_cache').run();
}

module.exports = { startEnrichment, getStatus, cancel, reset };
