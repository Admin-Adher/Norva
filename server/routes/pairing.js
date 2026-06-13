const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const { requireAuth, generateDeviceToken } = require('../auth');
const { getDb } = require('../db/sqlite');
const supabase = require('../services/supabase');

// ─── In-memory pending pair requests ────────────────────────────────────────
// Map<code, { id, code, deviceType, deviceName, userId, token, status, expiresAt, createdAt }>
const pairRequests = new Map();

// Purge expired entries periodically (every 10 min)
setInterval(() => {
    const now = Date.now();
    for (const [code, req] of pairRequests) {
        if (req.expiresAt < now) pairRequests.delete(code);
    }
}, 10 * 60 * 1000);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function uniqueCode() {
    let code;
    let attempts = 0;
    do {
        code = generateCode();
        attempts++;
    } while (pairRequests.has(code) && attempts < 100);
    return code;
}

function getHubUrl(req) {
    if (process.env.HUB_PUBLIC_URL) return process.env.HUB_PUBLIC_URL.replace(/\/$/, '');
    // Use X-Forwarded-Proto / Host if behind a proxy (trust proxy is set on app)
    const proto = req.protocol || 'http';
    const host = req.get('host') || req.hostname;
    return `${proto}://${host}`;
}

// ─── POST /api/pair/start ─────────────────────────────────────────────────────
// No auth required — TV device hasn't logged in yet.
router.post('/start', async (req, res) => {
    try {
        const { device_type = 'tv', device_name = 'Unknown Device' } = req.body || {};

        const id = randomUUID();
        const code = uniqueCode();
        const hubUrl = getHubUrl(req);
        const qr_text = `norva://pair?hub=${encodeURIComponent(hubUrl)}&code=${code}&id=${id}`;
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

        // Generate QR code as data URL
        let qr_data_url;
        try {
            qr_data_url = await QRCode.toDataURL(qr_text, { width: 300 });
        } catch (qrErr) {
            console.error('[Pairing] QR generation failed:', qrErr.message);
            qr_data_url = null;
        }

        const entry = {
            id,
            code,
            deviceType: device_type,
            deviceName: device_name,
            userId: null,
            token: null,
            status: 'pending',
            expiresAt,
            createdAt: Date.now()
        };
        pairRequests.set(code, entry);

        // Supabase: upsert into pair_requests (best-effort)
        const sb = supabase.getClient();
        if (sb) {
            try {
                await sb.from('pair_requests').upsert({
                    id,
                    code,
                    device_type,
                    device_name,
                    status: 'pending',
                    expires_at: new Date(expiresAt).toISOString()
                });
            } catch (sbErr) {
                console.warn('[Pairing] Supabase upsert failed (non-fatal):', sbErr.message);
            }
        }

        return res.json({
            id,
            code,
            qr_data_url,
            qr_text,
            expires_in: 300
        });
    } catch (err) {
        console.error('[Pairing] /start error:', err);
        return res.status(500).json({ error: 'Failed to start pairing' });
    }
});

// ─── GET /api/pair/poll/:code ─────────────────────────────────────────────────
// No auth — TV polls until approved.
router.get('/poll/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const entry = pairRequests.get(code);

        if (!entry) {
            // Try Supabase as fallback for cross-device approval
            const sb = supabase.getClient();
            if (sb) {
                try {
                    const { data } = await sb
                        .from('pair_requests')
                        .select('status, device_token')
                        .eq('code', code)
                        .single();

                    if (data) {
                        if (data.status === 'approved' && data.device_token) {
                            return res.json({ status: 'approved', token: data.device_token });
                        }
                        return res.json({ status: data.status || 'pending' });
                    }
                } catch (_) {
                    // Supabase lookup failed — fall through to not_found
                }
            }
            return res.json({ status: 'not_found' });
        }

        if (entry.expiresAt < Date.now()) {
            pairRequests.delete(code);
            return res.json({ status: 'expired' });
        }

        if (entry.status === 'approved' && entry.token) {
            return res.json({ status: 'approved', token: entry.token });
        }

        return res.json({ status: entry.status || 'pending' });
    } catch (err) {
        console.error('[Pairing] /poll error:', err);
        return res.status(500).json({ error: 'Poll failed' });
    }
});

// ─── POST /api/pair/approve ───────────────────────────────────────────────────
// Requires the mobile user's JWT.
router.post('/approve', requireAuth, async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ error: 'code is required' });

        const entry = pairRequests.get(code);
        if (!entry) return res.status(404).json({ error: 'Pair request not found' });
        if (entry.expiresAt < Date.now()) {
            pairRequests.delete(code);
            return res.status(410).json({ error: 'Pair request expired' });
        }
        if (entry.status !== 'pending') {
            return res.status(409).json({ error: 'Pair request already processed' });
        }

        const user = req.user;
        const deviceToken = generateDeviceToken(user, entry.id, entry.deviceType);

        // Hash token for storage (cost 8 — fast, device tokens are long-lived)
        const tokenHash = await bcrypt.hash(deviceToken, 8);

        // Persist to SQLite
        const db = getDb();
        db.prepare(`
            INSERT OR REPLACE INTO paired_devices
                (id, device_type, device_name, local_user_id, token_hash, revoked, last_seen_at, created_at)
            VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
        `).run(entry.id, entry.deviceType, entry.deviceName, user.id, tokenHash);

        // Mark in-memory entry as approved
        entry.status = 'approved';
        entry.userId = user.id;
        entry.token = deviceToken;

        // Supabase: update pair_requests row (best-effort)
        const sb = supabase.getClient();
        if (sb) {
            try {
                await sb.from('pair_requests').update({
                    status: 'approved',
                    device_token: deviceToken
                }).eq('code', code);
            } catch (sbErr) {
                console.warn('[Pairing] Supabase approve update failed (non-fatal):', sbErr.message);
            }
        }

        return res.json({ success: true, device_name: entry.deviceName });
    } catch (err) {
        console.error('[Pairing] /approve error:', err);
        return res.status(500).json({ error: 'Approval failed' });
    }
});

// ─── GET /api/pair/devices ────────────────────────────────────────────────────
// List all non-revoked paired devices for the authenticated user.
router.get('/devices', requireAuth, (req, res) => {
    try {
        const db = getDb();
        const devices = db.prepare(`
            SELECT id, device_type, device_name, last_seen_at, created_at
            FROM paired_devices
            WHERE local_user_id = ? AND revoked = 0
            ORDER BY created_at DESC
        `).all(req.user.id);

        return res.json({ devices });
    } catch (err) {
        console.error('[Pairing] /devices error:', err);
        return res.status(500).json({ error: 'Failed to list devices' });
    }
});

// ─── DELETE /api/pair/devices/:id ────────────────────────────────────────────
// Revoke a paired device.
router.delete('/devices/:id', requireAuth, (req, res) => {
    try {
        const db = getDb();
        const result = db.prepare(`
            UPDATE paired_devices SET revoked = 1
            WHERE id = ? AND local_user_id = ?
        `).run(req.params.id, req.user.id);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Device not found or not owned by you' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('[Pairing] /devices/:id DELETE error:', err);
        return res.status(500).json({ error: 'Failed to revoke device' });
    }
});

module.exports = router;
