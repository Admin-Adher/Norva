const db = require('../db');

let timer = null;
const DEFAULT_CLOUD_API_URL = 'https://api.norva.tv/functions/v1/norva-cloud';

function start() {
    if (timer) return;
    timer = setInterval(() => {
        pollOnce().catch(err => console.warn('[Norva Cloud] bridge poll failed:', err.message));
    }, 5000);
    pollOnce().catch(err => console.warn('[Norva Cloud] initial bridge poll failed:', err.message));
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

async function getLink() {
    const data = await db.loadDb();
    const link = data.settings?.norvaCloud;
    if (!link?.deviceToken) return null;
    return { data, link };
}

async function cloudRequest(link, path, options = {}) {
    const apiUrl = (link.apiUrl || process.env.NORVA_CLOUD_API_URL || DEFAULT_CLOUD_API_URL).replace(/\/+$/, '');
    const response = await fetch(`${apiUrl}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${link.deviceToken}`,
            ...(options.headers || {})
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(payload.error || `Norva Cloud responded with ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return payload;
}

async function pollOnce() {
    const state = await getLink();
    if (!state) return;

    const { data, link } = state;
    await cloudRequest(link, '/device/heartbeat', { method: 'POST', body: '{}' });
    link.lastHeartbeatAt = new Date().toISOString();

    const payload = await cloudRequest(link, '/device/commands?limit=10', { method: 'GET' });
    for (const command of payload.commands || []) {
        await handleCommand(link, command);
    }

    data.settings.norvaCloud = link;
    await db.saveDb(data);
}

async function handleCommand(link, command) {
    try {
        const payload = command.payload || {};
        link.lastCommandAt = new Date().toISOString();
        link.lastCommand = {
            id: command.id,
            command: command.command,
            payload,
            receivedAt: link.lastCommandAt
        };

        if (command.command === 'sync') {
            const syncService = require('./syncService');
            await syncService.syncAllIfDue('cloud-command');
        }

        await cloudRequest(link, `/device/commands/${encodeURIComponent(command.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'acknowledged' })
        });
    } catch (err) {
        await cloudRequest(link, `/device/commands/${encodeURIComponent(command.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: err.message || 'Hub command failed' })
        }).catch(() => {});
    }
}

module.exports = { start, stop, pollOnce };
