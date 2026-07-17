const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { requireAuth } = require('../auth');

// Middleware to ensure authentication
router.use(requireAuth);

/**
 * GET /api/history
 * Returns the watch history for the authenticated user
 */
router.get('/', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;

        const rows = db.prepare(`
            SELECT * FROM watch_history 
            WHERE user_id = ? 
            ORDER BY updated_at DESC 
            LIMIT ?
        `).all(userId, limit);

        const history = rows.map(row => ({
            ...row,
            data: JSON.parse(row.data || '{}')
        }));

        res.json(history);
    } catch (err) {
        console.error('[History] Error fetching history:', err);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

/**
 * POST /api/history
 * Saves/updates watch progress for an item
 */
router.post('/', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const { id, type, parentId, progress, duration, data, sourceId } = req.body;

        if (!id || !type) {
            return res.status(400).json({ error: 'Missing required fields (id, type)' });
        }

        const compositeId = `${userId}:${id}`;
        const timestamp = Date.now();

        // MERGE like the cloud edge does (audit 2026-07-17 P2): the web player's delta
        // heartbeat omits `data` on steady ticks precisely because it assumes the server
        // preserves the rich blob (title/poster/nextEpisode/prefs) from an earlier save —
        // `data = excluded.data` was wiping it to {} on the 2nd tick in hub mode, degrading
        // Continue Watching cards and breaking episode chaining. Duration likewise survives
        // an update that doesn't carry one (native exit before the player resolved it).
        const existing = db.prepare('SELECT duration, data FROM watch_history WHERE id = ?').get(compositeId);
        let mergedData = data || {};
        if (existing) {
            try { mergedData = { ...JSON.parse(existing.data || '{}'), ...(data || {}) }; } catch (_) { /* keep incoming */ }
        }
        const effectiveDuration = Number(duration) > 0 ? Number(duration) : (Number(existing?.duration) || 0);

        const stmt = db.prepare(`
            INSERT INTO watch_history (id, user_id, source_id, item_type, item_id, parent_id, progress, duration, updated_at, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source_id = excluded.source_id,
                progress = excluded.progress,
                duration = excluded.duration,
                updated_at = excluded.updated_at,
                data = excluded.data
        `);

        stmt.run(
            compositeId,
            userId,
            sourceId || null,
            type,
            id.toString(),
            parentId ? parentId.toString() : null,
            progress || 0,
            effectiveDuration,
            timestamp,
            JSON.stringify(mergedData)
        );

        res.json({ success: true, timestamp });
    } catch (err) {
        console.error('[History] Error saving progress:', err);
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

/**
 * DELETE /api/history/:itemId
 * Removes an item from the user's watch history
 */
router.delete('/:itemId', (req, res) => {
    try {
        const db = getDb();
        const userId = req.user.id;
        const itemId = req.params.itemId;

        const compositeId = `${userId}:${itemId}`;

        const stmt = db.prepare('DELETE FROM watch_history WHERE id = ? AND user_id = ?');
        const result = stmt.run(compositeId, userId);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Item not found in history' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[History] Error deleting history item:', err);
        res.status(500).json({ error: 'Failed to delete history item' });
    }
});

module.exports = router;
