const express = require('express');
const router = express.Router();
const tmdbService = require('../services/tmdbService');

/**
 * GET /api/tmdb/status — enrichment progress
 */
router.get('/status', (req, res) => {
    res.json(tmdbService.getStatus());
});

/**
 * POST /api/tmdb/enrich — start/resume background enrichment
 */
router.post('/enrich', async (req, res) => {
    try {
        const result = await tmdbService.startEnrichment();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/tmdb/cancel — stop a running enrichment
 */
router.post('/cancel', (req, res) => {
    tmdbService.cancel();
    res.json({ success: true });
});

/**
 * POST /api/tmdb/reset — clear all TMDB data (full re-enrichment)
 */
router.post('/reset', (req, res) => {
    try {
        tmdbService.reset();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
