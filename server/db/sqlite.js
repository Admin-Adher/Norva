const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.NODECAST_DATA_DIR
    ? path.resolve(process.env.NODECAST_DATA_DIR)
    : path.join(__dirname, '..', '..', 'data');
const dbPath = path.join(dataDir, 'content.db');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let db;

function getDb() {
    if (!db) {
        console.log('[SQLite] Opening database at', dbPath);
        db = new Database(dbPath);
        // Optimize performance
        db.pragma('busy_timeout = 5000');
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        initSchema();
    }
    return db;
}

function initSchema() {
    if (!db) throw new Error('Database not initialized');

    // Categories (Groups)
    db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:categoryId
            source_id INTEGER NOT NULL,
            category_id TEXT NOT NULL,
            type TEXT NOT NULL, -- 'live', 'movie', 'series'
            name TEXT NOT NULL,
            parent_id TEXT, -- For nested categories
            is_hidden INTEGER DEFAULT 0,
            data JSON -- Extra provider data
        );
        CREATE INDEX IF NOT EXISTS idx_categories_source_type ON categories(source_id, type);
    `);

    // Playlist Items (Channels, Movies, Series, Episodes)
    db.exec(`
        CREATE TABLE IF NOT EXISTS playlist_items (
            id TEXT PRIMARY KEY, -- Composite key: sourceId:itemId
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL, -- Original ID from provider
            type TEXT NOT NULL, -- 'live', 'movie', 'series', 'episode'
            name TEXT NOT NULL,
            category_id TEXT, -- maps to categories.category_id (not our composite id)
            parent_id TEXT, -- For episodes -> series_id
            
            -- Common Media Fields
            stream_icon TEXT,
            stream_url TEXT, -- Direct link if available
            container_extension TEXT,
            
            -- VOD/Series Specific
            rating REAL,
            year TEXT,
            added_at TEXT,
            
            -- App State
            is_hidden INTEGER DEFAULT 0,
            is_favorite INTEGER DEFAULT 0,
            
            data JSON -- Full original JSON object
        );
        CREATE INDEX IF NOT EXISTS idx_items_source_type ON playlist_items(source_id, type);
        CREATE INDEX IF NOT EXISTS idx_items_category ON playlist_items(source_id, category_id);
    `);

    // EPG Programs
    // Optimized for range queries
    db.exec(`
        CREATE TABLE IF NOT EXISTS epg_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL, -- matches playlist_items.id if possible, or mapping key
            source_id INTEGER NOT NULL,
            start_time INTEGER NOT NULL, -- Unix timestamp (ms)
            end_time INTEGER NOT NULL,   -- Unix timestamp (ms)
            title TEXT,
            description TEXT,
            data JSON
        );
        CREATE INDEX IF NOT EXISTS idx_epg_channel_time ON epg_programs(channel_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_epg_cleanup ON epg_programs(end_time); -- For deleting old programs
    `);

    // Sync Status
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_status (
            source_id INTEGER NOT NULL,
            type TEXT NOT NULL, -- 'live', 'vod', 'series', 'epg'
            last_sync INTEGER NOT NULL,
            status TEXT, -- 'success', 'error', 'syncing'
            error TEXT,
            PRIMARY KEY (source_id, type)
        );
    `);

    // User Favorites (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            source_id INTEGER NOT NULL,
            item_id TEXT NOT NULL,
            item_type TEXT NOT NULL, -- 'channel', 'movie', 'series'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, source_id, item_id, item_type)
        );
        CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_favorites_user_type ON favorites(user_id, item_type);
    `);

    // Watch History (per-user)
    db.exec(`
        CREATE TABLE IF NOT EXISTS watch_history (
            id TEXT PRIMARY KEY, -- Composite key: user_id:item_id
            user_id INTEGER NOT NULL,
            source_id INTEGER, -- Source ID for Xtream/M3U
            item_type TEXT NOT NULL, -- 'movie', 'episode'
            item_id TEXT NOT NULL, -- The original item ID (stream_id or composite)
            parent_id TEXT, -- For episodes (series ID)
            progress INTEGER DEFAULT 0, -- Current position in seconds
            duration INTEGER DEFAULT 0, -- Total duration in seconds
            updated_at INTEGER NOT NULL, -- Timestamp
            data JSON -- Snapshot of item data (title, poster, etc)
        );
        CREATE INDEX IF NOT EXISTS idx_history_user_updated ON watch_history(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_history_user_item ON watch_history(user_id, item_id);
    `);

    // Migration: Add source_id column if missing (for existing databases)
    try {
        db.exec(`ALTER TABLE watch_history ADD COLUMN source_id INTEGER`);
        console.log('[SQLite] Added source_id column to watch_history');
    } catch (e) {
        // Column already exists, ignore
    }

    // Migration: dedup + TMDB enrichment columns on playlist_items
    const itemMigrations = [
        `ALTER TABLE playlist_items ADD COLUMN dedup_key TEXT`,
        `ALTER TABLE playlist_items ADD COLUMN tmdb_id INTEGER`,
        `ALTER TABLE playlist_items ADD COLUMN tmdb_data JSON`,
        `ALTER TABLE playlist_items ADD COLUMN playback_status TEXT DEFAULT 'unknown'`,
        `ALTER TABLE playlist_items ADD COLUMN playback_failures INTEGER DEFAULT 0`,
        `ALTER TABLE playlist_items ADD COLUMN playback_last_error TEXT`,
        `ALTER TABLE playlist_items ADD COLUMN playback_checked_at INTEGER`,
        `ALTER TABLE playlist_items ADD COLUMN playback_mode TEXT DEFAULT 'unknown'`,
        `ALTER TABLE playlist_items ADD COLUMN playback_mode_reason TEXT`,
        `ALTER TABLE playlist_items ADD COLUMN playback_mode_checked_at INTEGER`
    ];
    for (const sql of itemMigrations) {
        try {
            db.exec(sql);
            console.log('[SQLite] Migration applied:', sql);
        } catch (e) {
            // Column already exists, ignore
        }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_dedup ON playlist_items(type, dedup_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_playback_status ON playlist_items(type, playback_status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_playback_mode ON playlist_items(type, playback_mode)`);

    // TMDB lookup cache: one search per unique dedup_key, shared across sources
    db.exec(`
        CREATE TABLE IF NOT EXISTS tmdb_cache (
            dedup_key TEXT NOT NULL,
            type TEXT NOT NULL, -- 'movie' or 'series'
            tmdb_id INTEGER,    -- NULL when no match found
            data JSON,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (dedup_key, type)
        );
    `);

    // Paired devices for TV/mobile QR pairing
    db.exec(`
        CREATE TABLE IF NOT EXISTS paired_devices (
            id TEXT PRIMARY KEY,
            hub_id TEXT,
            device_type TEXT NOT NULL,
            device_name TEXT,
            local_user_id INTEGER NOT NULL,
            supabase_device_id TEXT,
            token_hash TEXT,
            revoked INTEGER DEFAULT 0,
            last_seen_at TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);

    console.log('[SQLite] Schema initialized');
    backfillDedupKeys();
}

/**
 * Compute dedup_key for existing rows that don't have one yet
 * (one-shot per startup, fast no-op once everything is backfilled)
 */
function backfillDedupKeys() {
    try {
        const { computeDedupKey } = require('../services/mediaNormalizer');
        const rows = db.prepare(`
            SELECT id, name, year FROM playlist_items
            WHERE type IN ('movie', 'series') AND dedup_key IS NULL
        `).all();
        if (rows.length === 0) return;

        const update = db.prepare('UPDATE playlist_items SET dedup_key = ? WHERE id = ?');
        const run = db.transaction((batch) => {
            for (const row of batch) {
                update.run(computeDedupKey(row.name, row.year), row.id);
            }
        });
        const BATCH = 500;
        for (let i = 0; i < rows.length; i += BATCH) {
            run(rows.slice(i, i + BATCH));
        }
        console.log(`[SQLite] Backfilled dedup_key for ${rows.length} items`);
    } catch (err) {
        console.error('[SQLite] dedup_key backfill failed:', err.message);
    }
}

// ============================================================
// Favorites CRUD Operations
// ============================================================
const favorites = {
    getAll(userId, sourceId = null, itemType = null) {
        const db = getDb();
        let sql = 'SELECT * FROM favorites WHERE user_id = ?';
        const params = [userId];

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(sourceId);
        }
        if (itemType) {
            sql += ' AND item_type = ?';
            params.push(itemType);
        }

        sql += ' ORDER BY created_at DESC';
        return db.prepare(sql).all(...params);
    },

    add(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO favorites (user_id, source_id, item_id, item_type)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    remove(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const stmt = db.prepare(`
            DELETE FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `);
        const result = stmt.run(userId, sourceId, itemId, itemType);
        return result.changes > 0;
    },

    isFavorite(userId, sourceId, itemId, itemType = 'channel') {
        const db = getDb();
        const row = db.prepare(`
            SELECT 1 FROM favorites 
            WHERE user_id = ? AND source_id = ? AND item_id = ? AND item_type = ?
        `).get(userId, sourceId, itemId, itemType);
        return !!row;
    },

    // Get all favorites for a user, grouped by type (for bulk checks)
    getAllAsSet(userId) {
        const db = getDb();
        const rows = db.prepare('SELECT source_id, item_id, item_type FROM favorites WHERE user_id = ?').all(userId);
        const set = new Set();
        for (const row of rows) {
            set.add(`${row.source_id}:${row.item_id}:${row.item_type}`);
        }
        return set;
    }
};

module.exports = {
    getDb,
    initSchema,
    favorites
};
