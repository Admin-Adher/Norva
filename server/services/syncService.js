const { getDb } = require('../db/sqlite');
const { sources, settings } = require('../db'); // For source config and settings
const xtreamApi = require('./xtreamApi');
const m3uParser = require('./m3uParser');
const epgParser = require('./epgParser');
const cache = require('./cache');
const { computeDedupKey } = require('./mediaNormalizer');
const { sanitizeErrorMessage } = require('../utils/upstreamError');

// Sync tracking
const activeSyncs = new Set(); // sourceId
const statusCache = new Map(); // `${sourceId}:${type}` -> latest status

function cacheStatus(sourceId, type, lastSync, status, error = null) {
    statusCache.set(`${sourceId}:${type}`, {
        source_id: sourceId,
        type,
        last_sync: lastSync,
        status,
        error
    });
}

class SyncService {
    constructor() {
        this.lastSyncTime = null; // Track when global sync last completed
        this._syncTimer = null;   // Server-side sync timer
        this._currentInterval = null;
    }

    getSyncIntervalHours(currentSettings) {
        const intervalHours = parseInt(currentSettings?.epgRefreshInterval, 10);
        return Number.isFinite(intervalHours) ? intervalHours : 24;
    }

    async getGlobalSyncFreshness(intervalHours) {
        if (intervalHours <= 0) {
            return { due: false, disabled: true, nextDueAt: null, reason: 'auto-sync disabled' };
        }

        const intervalMs = intervalHours * 60 * 60 * 1000;
        const now = Date.now();
        const staleBefore = now - intervalMs;
        const allSources = [];

        try {
            const sourceRows = await sources.getAll();
            const db = getDb();
            for (const row of sourceRows) {
                if (row.enabled) allSources.push(row);
            }

            if (allSources.length === 0) {
                return { due: false, nextDueAt: null, reason: 'no enabled sources' };
            }

            const statusRows = db.prepare(`
                SELECT source_id, last_sync, status
                FROM sync_status
                WHERE type = 'all'
            `).all();
            const statusBySource = new Map(statusRows.map(row => [Number(row.source_id), row]));
            let oldestSuccessfulSync = Infinity;

            for (const source of allSources) {
                if (activeSyncs.has(source.id)) {
                    return {
                        due: false,
                        nextDueAt: now + 60 * 1000,
                        reason: `${source.name || source.id} is already syncing`
                    };
                }

                const status = statusBySource.get(Number(source.id));
                if (status?.status === 'syncing' && now - status.last_sync < 30 * 60 * 1000) {
                    return {
                        due: false,
                        nextDueAt: status.last_sync + 30 * 60 * 1000,
                        reason: `${source.name || source.id} sync is already in progress`
                    };
                }

                if (!status || status.status !== 'success') {
                    return {
                        due: true,
                        nextDueAt: now,
                        reason: `missing successful sync for ${source.name || source.id}`
                    };
                }

                if (status.last_sync < staleBefore) {
                    return {
                        due: true,
                        nextDueAt: now,
                        reason: `${source.name || source.id} sync is stale`
                    };
                }

                oldestSuccessfulSync = Math.min(oldestSuccessfulSync, status.last_sync);
            }

            const nextDueAt = Number.isFinite(oldestSuccessfulSync)
                ? oldestSuccessfulSync + intervalMs
                : now + intervalMs;

            return {
                due: false,
                nextDueAt,
                reason: `fresh until ${new Date(nextDueAt).toLocaleString()}`
            };
        } catch (err) {
            console.warn('[Sync] Could not determine sync freshness:', err.message);
            return { due: true, nextDueAt: now, reason: 'freshness check failed' };
        }
    }

    /**
     * Get when the last global sync completed
     */
    getLastSyncTime() {
        return this.lastSyncTime;
    }

    /**
     * Start the server-side sync timer based on settings
     * Should be called once on server startup after initial sync
     */
    async startSyncTimer() {
        // Get interval from settings
        const currentSettings = await settings.get();
        const intervalHours = this.getSyncIntervalHours(currentSettings);

        // If interval is 0, don't start timer (manual only mode)
        if (intervalHours <= 0) {
            console.log('[Sync] Auto-sync disabled (manual only mode)');
            this.stopSyncTimer();
            this._currentInterval = 0;
            return;
        }

        // Don't restart if interval hasn't changed and timer exists
        if (this._currentInterval === intervalHours && this._syncTimer) {
            console.log(`[Sync] Timer already running for ${intervalHours} hours, not restarting`);
            return;
        }

        // Clear existing timer
        this.stopSyncTimer();

        const freshness = await this.getGlobalSyncFreshness(intervalHours);
        const delayMs = Math.max(
            60 * 1000,
            freshness.nextDueAt ? freshness.nextDueAt - Date.now() : intervalHours * 60 * 60 * 1000
        );
        const nextSyncTime = new Date(Date.now() + delayMs);
        console.log(`[Sync] Starting server-side sync timer: every ${intervalHours} hours`);
        console.log(`[Sync] Next scheduled sync at: ${nextSyncTime.toLocaleString()}`);

        this._syncTimer = setTimeout(async () => {
            console.log('[Sync] Scheduled sync triggered');
            await this.syncAll();
            this._syncTimer = null;
            await this.startSyncTimer();
        }, delayMs);
        this._syncTimer.unref?.();

        this._currentInterval = intervalHours;
    }

    /**
     * Stop the server-side sync timer
     */
    stopSyncTimer() {
        if (this._syncTimer) {
            clearInterval(this._syncTimer);
            this._syncTimer = null;
        }
    }

    /**
     * Restart the sync timer with updated settings
     * Called when sync interval setting changes
     */
    async restartSyncTimer() {
        await this.startSyncTimer();
    }

    /**
     * Sync all enabled sources
     */
    async syncAll() {
        console.log('[Sync] Starting global sync...');
        try {
            const allSources = await sources.getAll();
            for (const source of allSources) {
                if (source.enabled) {
                    // Run sequentially to not overload
                    await this.syncSource(source.id);
                }
            }
            this.lastSyncTime = new Date();
            console.log('[Sync] Global sync completed at', this.lastSyncTime.toISOString());

            // Kick off TMDB enrichment in the background (no-op without API key)
            try {
                const tmdbService = require('./tmdbService');
                tmdbService.startEnrichment().catch(err => {
                    console.warn('[Sync] TMDB enrichment failed to start:', err.message);
                });
            } catch (e) {
                // tmdbService unavailable, ignore
            }
        } catch (err) {
            console.error('[Sync] Global sync failed:', err);
        }
    }

    async syncAllIfDue(reason = 'scheduled') {
        const currentSettings = await settings.get();
        const intervalHours = this.getSyncIntervalHours(currentSettings);
        const freshness = await this.getGlobalSyncFreshness(intervalHours);

        if (!freshness.due) {
            console.log(`[Sync] Skipping ${reason} sync: ${freshness.reason}`);
            return false;
        }

        console.log(`[Sync] ${reason} sync is due: ${freshness.reason}`);
        await this.syncAll();
        return true;
    }

    /**
     * Start sync for a source
     */
    async syncSource(sourceId) {
        if (activeSyncs.has(sourceId)) {
            console.log(`[Sync] Source ${sourceId} is already syncing`);
            return;
        }

        activeSyncs.add(sourceId);

        try {
            const db = getDb();
            const source = await sources.getById(sourceId);

            if (!source) {
                throw new Error(`Source ${sourceId} not found`);
            }

            console.log(`[Sync] Starting sync for source ${source.name} (ID: ${sourceId})`);

            if (!source.enabled) {
                console.log(`[Sync] Skipping disabled source ${source.name}`);
                activeSyncs.delete(sourceId);
                return;
            }

            // Update status
            this.updateSyncStatus(sourceId, 'all', 'syncing');

            if (source.type === 'xtream') {
                await this.syncXtream(source);
            } else if (source.type === 'm3u') {
                await this.syncM3u(source);
            } else if (source.type === 'epg') {
                await this.syncEpg(source);
            }

            this.updateSyncStatus(sourceId, 'all', 'success');
            console.log(`[Sync] Completed sync for source ${source.name}`);

        } catch (err) {
            console.error(`[Sync] Failed sync for source ${sourceId}:`, err);
            this.updateSyncStatus(sourceId, 'all', 'error', err.message);
        } finally {
            activeSyncs.delete(sourceId);
        }
    }

    /**
     * Update sync status in DB
     */
    updateSyncStatus(sourceId, type, status, error = null) {
        const lastSync = Date.now();
        cacheStatus(sourceId, type, lastSync, status, error);

        try {
            const db = getDb();
            const stmt = db.prepare(`
                INSERT INTO sync_status (source_id, type, last_sync, status, error)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(source_id, type) DO UPDATE SET
                    last_sync = excluded.last_sync,
                    status = excluded.status,
                    error = excluded.error
            `);
            stmt.run(sourceId, type, lastSync, status, error);
        } catch (err) {
            console.error('[Sync] Failed to persist sync status:', err);
        }
    }

    /**
     * Get sync statuses, falling back to the in-memory cache if SQLite is busy.
     */
    getSyncStatuses() {
        try {
            const db = getDb();
            const rows = db.prepare('SELECT * FROM sync_status').all();
            for (const row of rows) {
                cacheStatus(row.source_id, row.type, row.last_sync, row.status, row.error);
            }
            return rows;
        } catch (err) {
            console.error('[Sync] Failed to read sync status from SQLite:', err);
            return this.getCachedSyncStatuses();
        }
    }

    getCachedSyncStatuses() {
        return Array.from(statusCache.values());
    }

    /**
     * Clear all locally stored content for a source before a clean resync.
     * User-owned state such as favorites and watch history is preserved.
     */
    async clearSourceContent(sourceId) {
        const id = parseInt(sourceId, 10);
        if (!Number.isInteger(id)) {
            throw new Error('Invalid source ID');
        }

        if (activeSyncs.has(id)) {
            throw new Error('This source is already syncing. Wait for it to finish before hard refreshing.');
        }

        const source = await sources.getById(id);
        if (!source) {
            throw new Error(`Source ${id} not found`);
        }

        const db = getDb();
        const clearContent = db.transaction(() => {
            const categories = db.prepare('DELETE FROM categories WHERE source_id = ?').run(id).changes;
            const items = db.prepare('DELETE FROM playlist_items WHERE source_id = ?').run(id).changes;
            const epg = db.prepare('DELETE FROM epg_programs WHERE source_id = ?').run(id).changes;
            const statuses = db.prepare('DELETE FROM sync_status WHERE source_id = ?').run(id).changes;
            return { categories, items, epg, statuses };
        });

        const cleared = clearContent();
        cache.clearSource(id);

        for (const key of Array.from(statusCache.keys())) {
            if (key.startsWith(`${id}:`)) {
                statusCache.delete(key);
            }
        }

        console.log(
            `[Sync] Hard refresh cleared source ${id}: ` +
            `${cleared.categories} categories, ${cleared.items} items, ` +
            `${cleared.epg} EPG programmes, ${cleared.statuses} status rows`
        );

        return { source, cleared };
    }

    /**
     * Clear local content and start a normal source sync in the background.
     */
    async hardRefreshSource(sourceId) {
        const result = await this.clearSourceContent(sourceId);
        this.syncSource(parseInt(sourceId, 10)).catch(err => {
            console.error(`[Sync] Hard refresh sync failed for source ${sourceId}:`, err);
        });
        return result;
    }

    /**
     * Xtream Sync Logic
     */
    async syncXtream(source) {
        const api = xtreamApi.createFromSource(source);
        const db = getDb();

        // 1. Live Categories
        console.log(`[Sync] Fetching Live Categories for ${source.name}`);
        const liveCats = await api.getLiveCategories();
        await this.saveCategories(source.id, 'live', liveCats);

        // 2. Live Streams
        console.log(`[Sync] Fetching Live Streams for ${source.name}`);
        const liveStreams = await api.getLiveStreams();
        await this.saveStreams(source.id, 'live', liveStreams);

        // 3. VOD Categories
        console.log(`[Sync] Fetching VOD Categories for ${source.name}`);
        const vodCats = await api.getVodCategories();
        await this.saveCategories(source.id, 'movie', vodCats);

        // 4. VOD Streams
        console.log(`[Sync] Fetching VOD Streams for ${source.name}`);
        const vodStreams = await api.getVodStreams();
        await this.saveStreams(source.id, 'movie', vodStreams);

        // 5. Series Categories
        console.log(`[Sync] Fetching Series Categories for ${source.name}`);
        const seriesCats = await api.getSeriesCategories();
        await this.saveCategories(source.id, 'series', seriesCats);

        // 6. Series
        console.log(`[Sync] Fetching Series for ${source.name}`);
        const series = await api.getSeries();
        await this.saveStreams(source.id, 'series', series);

        // 7. EPG (Xmltv)
        // Try to fetch XMLTV if available
        console.log(`[Sync] Fetching EPG for ${source.name}`);
        try {
            const xmltvUrl = api.getXmltvUrl();
            await this.syncEpgFromUrl(source.id, xmltvUrl);
        } catch (e) {
            console.warn('[Sync] XMLTV fetch failed, skipping EPG sync for now:', e.message);
        }
    }

    /**
     * Batch save categories
     */
    async saveCategories(sourceId, type, categories) {
        if (!categories || categories.length === 0) return;
        console.log(`[Sync] Saving ${categories.length} ${type} categories for source ${sourceId}...`);
        const db = getDb();
        const stmt = db.prepare(`
            INSERT INTO categories (id, source_id, category_id, type, name, parent_id, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                data = excluded.data
        `);

        const insertBatch = db.transaction((batch) => {
            for (const cat of batch) {
                const catId = cat.category_id; // standard xtream field
                const name = cat.category_name;
                const id = `${sourceId}:${catId}`;
                stmt.run(id, sourceId, String(catId), type, name, cat.parent_id || null, JSON.stringify(cat));
            }
        });

        // Reduced batch size for better event loop interleaving
        const BATCH_SIZE = 100;
        for (let i = 0; i < categories.length; i += BATCH_SIZE) {
            insertBatch(categories.slice(i, i + BATCH_SIZE));
            // Yield to event loop between batches to allow other requests
            await new Promise(resolve => setImmediate(resolve));
        }

        console.log(`[Sync] Saved ${categories.length} ${type} categories`);
    }

    /**
     * Batch save streams (channels, vod, series)
     * Also purges stale entries that no longer exist in the source (unless skipPurge is true)
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Array} items - Items to save
     * @param {Object} options - Options { skipPurge: boolean }
     * @returns {Set} Set of synced IDs (for external purge if skipPurge was true)
     */
    async saveStreams(sourceId, type, items, options = {}) {
        if (!items || items.length === 0) return new Set();
        const db = getDb();
        const { skipPurge = false } = options;

        // Collect all IDs we're syncing
        const syncedIds = new Set();

        const stmt = db.prepare(`
            INSERT INTO playlist_items (
                id, source_id, item_id, type, name, category_id,
                stream_icon, stream_url, container_extension,
                rating, year, added_at, dedup_key, data
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                category_id = excluded.category_id,
                stream_icon = excluded.stream_icon,
                container_extension = excluded.container_extension,
                dedup_key = excluded.dedup_key,
                data = excluded.data
        `);

        const insertBatch = db.transaction((batch) => {
            for (const item of batch) {
                // Map fields based on type
                let itemId, name, catId, icon, container;
                let rating = null, year = null, added = null;

                if (type === 'live') {
                    itemId = item.stream_id;
                    name = item.name || `Channel ${item.stream_id}`;
                    catId = item.category_id;
                    icon = item.stream_icon;
                    added = item.added;
                } else if (type === 'movie') {
                    itemId = item.stream_id;
                    name = item.name || `Movie ${item.stream_id}`;
                    catId = item.category_id;
                    icon = item.stream_icon; // or cover
                    container = item.container_extension;
                    rating = item.rating;
                    added = item.added;
                } else if (type === 'series') {
                    itemId = item.series_id;
                    name = item.name || `Series ${item.series_id}`;
                    catId = item.category_id;
                    icon = item.cover;
                    rating = item.rating;
                    year = item.releaseDate;
                    added = item.last_modified;
                }

                const id = `${sourceId}:${itemId}`;
                syncedIds.add(id);

                const dedupKey = (type === 'movie' || type === 'series')
                    ? computeDedupKey(name, year)
                    : null;

                stmt.run(
                    id,
                    sourceId,
                    String(itemId),
                    type,
                    name,
                    String(catId),
                    icon,
                    item.stream_url || null, // Direct URL when provided (M3U), Xtream URLs built on the fly
                    container,
                    rating,
                    year,
                    added,
                    dedupKey,
                    JSON.stringify(item)
                );
            }
        });

        // Reduced batch size for better event loop interleaving
        const BATCH_SIZE = 100;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            insertBatch(items.slice(i, i + BATCH_SIZE));
            // Yield to event loop between batches to allow other requests
            await new Promise(resolve => setImmediate(resolve));
        }

        // Purge stale entries (skip if doing batch sync like M3U)
        if (!skipPurge && syncedIds.size > 0) {
            await this.purgeStaleItems(sourceId, type, syncedIds);
        }

        console.log(`[Sync] Saved ${items.length} ${type} items`);
        return syncedIds;
    }

    /**
     * Purge stale items that are no longer in the source
     * @param {number} sourceId - Source ID
     * @param {string} type - Type of items (live, movie, series)
     * @param {Set} syncedIds - Set of IDs that should be kept
     */
    async purgeStaleItems(sourceId, type, syncedIds) {
        if (!syncedIds || syncedIds.size === 0) return;

        const db = getDb();
        db.exec('CREATE TEMP TABLE IF NOT EXISTS synced_ids (id TEXT PRIMARY KEY)');
        db.exec('DELETE FROM synced_ids');

        const insertTemp = db.prepare('INSERT OR IGNORE INTO synced_ids (id) VALUES (?)');
        const insertTempBatch = db.transaction((ids) => {
            for (const id of ids) {
                insertTemp.run(id);
            }
        });
        insertTempBatch([...syncedIds]);

        const deleteStmt = db.prepare(`
            DELETE FROM playlist_items 
            WHERE source_id = ? AND type = ? 
            AND id NOT IN (SELECT id FROM synced_ids)
        `);
        const deleted = deleteStmt.run(sourceId, type);

        if (deleted.changes > 0) {
            console.log(`[Sync] Purged ${deleted.changes} stale ${type} items`);
        }
    }


    /**
     * Sync EPG from URL (Streaming - Memory Efficient)
     * Processes EPG files in batches to avoid OOM on large EPG data
     */
    async syncEpgFromUrl(sourceId, url) {
        console.log(`[Sync] Fetching EPG from: ${sanitizeErrorMessage(url).substring(0, 60)}...`);

        // Temporary memory logging for verification
        const logMemory = () => {
            const used = process.memoryUsage();
            console.log(`[Sync] Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap`);
        };

        logMemory();

        const db = getDb();
        let allChannels = [];
        let totalProgrammes = 0;
        let batchCount = 0;

        // Clear old programmes first
        db.prepare('DELETE FROM epg_programs WHERE source_id = ?').run(sourceId);

        const programmeStmt = db.prepare(`
            INSERT INTO epg_programs (channel_id, source_id, start_time, end_time, title, description, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const insertProgrammes = db.transaction((progs) => {
            for (const p of progs) {
                programmeStmt.run(
                    p.channelId,
                    sourceId,
                    p.start ? p.start.getTime() : 0,
                    p.stop ? p.stop.getTime() : 0,
                    p.title,
                    p.description || p.desc,
                    JSON.stringify(p)
                );
            }
        });

        // Stream and process in batches (default 1000 programmes per batch)
        for await (const batch of epgParser.fetchAndParseStreaming(url)) {
            batchCount++;

            // Collect channels from first batch
            if (batch.channels) {
                allChannels = batch.channels;
            }

            // Save this batch of programmes immediately
            if (batch.programmes.length > 0) {
                insertProgrammes(batch.programmes);
                totalProgrammes += batch.programmes.length;
            }

            // Log progress every 10 batches
            if (batchCount % 10 === 0) {
                console.log(`[Sync] Processed ${totalProgrammes} programmes so far...`);
                logMemory();
            }

            // Yield to event loop
            await new Promise(resolve => setImmediate(resolve));
        }

        console.log(`[Sync] EPG Parsed: ${allChannels.length} channels, ${totalProgrammes} programmes`);
        logMemory();

        // Save EPG Channels
        if (allChannels.length > 0) {
            const channelStmt = db.prepare(`
                INSERT INTO playlist_items (
                    id, source_id, item_id, type, name, stream_icon, 
                    stream_url, category_id, data
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    stream_icon = excluded.stream_icon,
                    data = excluded.data
            `);

            const insertChannels = db.transaction((chanList) => {
                for (const ch of chanList) {
                    const id = `${sourceId}:${ch.id}`;
                    channelStmt.run(
                        id,
                        sourceId,
                        ch.id,
                        'epg_channel',
                        ch.name,
                        ch.icon || null,
                        null,
                        null,
                        JSON.stringify(ch)
                    );
                }
            });

            insertChannels(allChannels);
            console.log(`[Sync] Saved ${allChannels.length} EPG channels`);
        }

        console.log(`[Sync] Saved ${totalProgrammes} programmes`);
    }

    /**
     * M3U Sync Logic (Streaming - Memory Efficient)
     * Processes M3U files in batches to avoid OOM on large playlists
     */
    async syncM3u(source) {
        console.log(`[Sync] Fetching M3U playlist for ${source.name}`);

        // Temporary memory logging for verification
        const logMemory = () => {
            const used = process.memoryUsage();
            console.log(`[Sync] Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB heap`);
        };

        logMemory();

        const allGroups = new Set();
        const allSyncedIds = new Set(); // Collect IDs across all batches
        let totalChannels = 0;
        let batchCount = 0;

        // Stream and process in batches (default 500 channels per batch)
        for await (const batch of m3uParser.fetchAndParseStreaming(source.url)) {
            batchCount++;

            // Map M3U channel format to our schema
            const playlistItems = batch.channels.map(ch => ({
                stream_id: ch.id,
                name: ch.name,
                category_id: ch.groupTitle || 'Uncategorized',
                stream_icon: ch.tvgLogo,
                stream_url: ch.url,
                tvgId: ch.tvgId || null,
            }));

            // Save this batch immediately (skip purge - we'll do it at the end)
            if (playlistItems.length > 0) {
                const batchIds = await this.saveStreams(source.id, 'live', playlistItems, { skipPurge: true });
                batchIds.forEach(id => allSyncedIds.add(id));
                totalChannels += playlistItems.length;
            }

            // Collect groups for category creation at the end
            batch.groups.forEach(g => allGroups.add(g));

            // Log progress every 10 batches
            if (batchCount % 10 === 0) {
                console.log(`[Sync] Processed ${totalChannels} channels so far...`);
                logMemory();
            }
        }

        console.log(`[Sync] M3U Parsed: ${totalChannels} channels, ${allGroups.size} groups`);
        logMemory();

        // Purge stale items after all batches are complete
        if (allSyncedIds.size > 0) {
            await this.purgeStaleItems(source.id, 'live', allSyncedIds);
        }

        // Save Categories (Groups) at the end
        const categories = Array.from(allGroups).map(name => ({
            category_id: name,
            category_name: name,
            parent_id: null
        }));

        await this.saveCategories(source.id, 'live', categories);
        console.log(`[Sync] M3U sync complete for ${source.name}`);
    }

    /**
     * EPG Source Sync Logic
     */
    async syncEpg(source) {
        console.log(`[Sync] Fetching standalone EPG for ${source.name}`);
        await this.syncEpgFromUrl(source.id, source.url);
    }
}

module.exports = new SyncService();
