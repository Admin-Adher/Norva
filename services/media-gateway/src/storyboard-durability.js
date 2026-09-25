'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

// Admission controls persistence only. The Edge still authorizes the owner,
// current source and exact file again before every resumed provider read.
function createStoryboardDurabilityPolicy(env = {}) {
    const directory = String(env.STORYBOARD_PRIVATE_DIR || '').trim();
    const sources = String(env.STORYBOARD_DURABLE_SOURCE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const raw = String(env.STORYBOARD_DURABLE_ROLLOUT_BPS || '0').trim();
    const valid = /^\d{1,5}$/.test(raw) && Number(raw) <= 10000 && sources.length <= 1000 && sources.every(uuid);
    const basisPoints = valid ? Number(raw) : 0;
    const sourceIds = new Set(valid ? sources : []);
    const enabled = Boolean(valid && directory && path.isAbsolute(directory) && (basisPoints || sourceIds.size));
    return {
        enabled,
        directory,
        admits(ownerId, sourceId) {
            if (!enabled || !uuid(ownerId) || !uuid(sourceId)) return false;
            if (sourceIds.has(sourceId) || basisPoints === 10000) return true;
            if (!basisPoints) return false;
            const bucket = crypto.createHash('sha256').update(ownerId.toLowerCase()).digest().readUInt32BE(0) % 10000;
            return bucket < basisPoints;
        },
        publicStatus() {
            return { protocol: 2, enabled, providerScoped: enabled && basisPoints === 0,
                rolloutBasisPoints: enabled ? basisPoints : 0, selectedSources: sourceIds.size,
                scope: !enabled ? 'disabled' : basisPoints === 10000 ? 'all-authenticated-owners'
                    : basisPoints ? 'stable-owner-cohort' : 'selected-sources' };
        },
    };
}
module.exports = { createStoryboardDurabilityPolicy };
