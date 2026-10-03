'use strict';
const { createHash } = require('node:crypto');

// Provider guides are read-only snapshots. Scope them to the authenticated
// owner/source revision AND exact credentials; never reuse another owner's
// feed or a feed from before a credential replacement.
function guideSnapshotKey(body) {
    if (!/^[a-f0-9]{64}$/.test(String(body.cacheScope || ''))) return '';
    return createHash('sha256').update(JSON.stringify([
        body.cacheScope, String(body.serverUrl).replace(/\/+$/, ''), body.username, body.password,
    ])).digest('hex');
}

function createGuideSnapshotCache({ maxBytes = 256 * 1024 * 1024,
    freshMs = 10 * 60 * 1000, retainMs = 6 * 60 * 60 * 1000, now = Date.now } = {}) {
    const entries = new Map();
    let bytes = 0;
    const remove = key => { const entry = entries.get(key); if (entry) bytes -= entry.raw.length; entries.delete(key); };
    return {
        get(key) {
            const entry = key && entries.get(key);
            if (!entry) return null;
            if (now() - entry.at >= retainMs) { remove(key); return null; }
            entries.delete(key); entries.set(key, entry);
            return { raw: entry.raw, fresh: now() - entry.at < freshMs };
        },
        set(key, raw) {
            if (!key || !Buffer.isBuffer(raw) || raw.length > maxBytes) return;
            for (const [id, entry] of entries) if (now() - entry.at >= retainMs) remove(id);
            remove(key);
            while (entries.size && bytes + raw.length > maxBytes) remove(entries.keys().next().value);
            entries.set(key, { raw, at: now() }); bytes += raw.length;
        },
        get bytes() { return bytes; },
    };
}

module.exports = { guideSnapshotKey, createGuideSnapshotCache };
