const express = require('express');
const pkg = require('../../package.json');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();
const DEFAULT_CLOUD_API_URL = 'https://api.norva.tv/functions/v1/norva-cloud';

function cloudApiUrl() {
    return (process.env.NORVA_CLOUD_API_URL || DEFAULT_CLOUD_API_URL).replace(/\/+$/, '');
}

function publicLink(link) {
    if (!link) return { linked: false, apiUrl: cloudApiUrl() };
    return {
        linked: Boolean(link.deviceId && link.deviceToken),
        apiUrl: link.apiUrl || cloudApiUrl(),
        deviceId: link.deviceId || null,
        deviceName: link.deviceName || null,
        linkedAt: link.linkedAt || null,
        linkedByLocalUserId: link.linkedByLocalUserId || null,
        lastHeartbeatAt: link.lastHeartbeatAt || null,
        lastCommandAt: link.lastCommandAt || null
    };
}

async function getSettings() {
    const data = await db.loadDb();
    data.settings = data.settings || db.getDefaultSettings();
    return { data, settings: data.settings };
}

router.get('/status', auth.requireAuth, async (req, res) => {
    try {
        const { settings } = await getSettings();
        res.json(publicLink(settings.norvaCloud));
    } catch (err) {
        console.error('Cloud status failed:', err);
        res.status(500).json({ error: 'Unable to read cloud link status' });
    }
});

router.post('/link', auth.requireAuth, async (req, res) => {
    try {
        const cloudAccessToken = String(req.body.cloudAccessToken || '').trim();
        if (!cloudAccessToken) {
            return res.status(400).json({ error: 'cloudAccessToken is required' });
        }

        const apiUrl = cloudApiUrl();
        const deviceName = String(req.body.deviceName || process.env.HUB_NAME || 'Norva Hub').trim();
        const response = await fetch(`${apiUrl}/devices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cloudAccessToken}`
            },
            body: JSON.stringify({
                deviceType: 'hub',
                deviceName,
                platform: process.platform,
                appVersion: pkg.version,
                trusted: true,
                issueDeviceToken: true,
                capabilities: {
                    localHub: true,
                    commandTarget: true,
                    commandSource: true,
                    offlineMode: true
                }
            })
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            return res.status(response.status).json({
                error: payload.error || 'Norva Cloud refused the hub link',
                details: payload.details
            });
        }
        if (!payload.device?.id || !payload.deviceToken) {
            return res.status(502).json({ error: 'Norva Cloud did not return a device session' });
        }

        const { data, settings } = await getSettings();
        settings.norvaCloud = {
            apiUrl,
            deviceId: payload.device.id,
            deviceName: payload.device.device_name || deviceName,
            deviceToken: payload.deviceToken,
            linkedAt: new Date().toISOString(),
            linkedByLocalUserId: req.user.id,
            lastHeartbeatAt: null,
            lastCommandAt: null
        };
        data.settings = settings;
        await db.saveDb(data);

        res.status(201).json(publicLink(settings.norvaCloud));
    } catch (err) {
        console.error('Cloud link failed:', err);
        res.status(500).json({ error: 'Unable to link this hub to Norva Cloud' });
    }
});

router.post('/unlink', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { data, settings } = await getSettings();
        delete settings.norvaCloud;
        data.settings = settings;
        await db.saveDb(data);
        res.json({ linked: false, apiUrl: cloudApiUrl() });
    } catch (err) {
        console.error('Cloud unlink failed:', err);
        res.status(500).json({ error: 'Unable to unlink this hub' });
    }
});

module.exports = router;
