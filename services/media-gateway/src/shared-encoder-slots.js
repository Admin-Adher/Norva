'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// All gateways using the same GPU mount the same root and use the same limit.
// A crashed process leaves a closed slot; an operator may recover it only after
// proving that its container and encoder children have stopped.
function encoderSlotWeight(profile = {}) {
    const width = Number(profile.videoWidth ?? profile.video_width ?? profile.width);
    const height = Number(profile.videoHeight ?? profile.video_height ?? profile.height);
    if (!(width > 0 && height > 0)) return 4;
    const rate = Number(profile.videoFrameRateNumerator) / Number(profile.videoFrameRateDenominator);
    const fps = Number.isFinite(rate) && rate > 0 ? rate : 30;
    return Math.max(1, Math.ceil(width * height / (1920 * 1080) * Math.max(1, fps / 30)));
}

function createSharedEncoderSlots(root, limit) {
    if (!root) return null;
    if (!path.isAbsolute(root) || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error('ENCODER_POOL_CONFIG');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('ENCODER_POOL_UNSAFE');
    const config = path.join(root, 'capacity.json');
    try { fs.writeFileSync(config, JSON.stringify({ limit }), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (JSON.parse(fs.readFileSync(config, 'utf8')).limit !== limit) throw new Error('ENCODER_POOL_LIMIT_MISMATCH');
    function acquireOne() {
            for (let i = 0; i < limit; i++) {
                const dir = path.join(root, `slot-${i}`);
                try { fs.mkdirSync(dir, { mode: 0o700 }); }
                catch (e) { if (e.code === 'EEXIST') continue; return null; }
                const nonce = crypto.randomBytes(16).toString('hex');
                try { fs.writeFileSync(path.join(dir, nonce), '', { flag: 'wx', mode: 0o600 }); }
                catch (_) { return null; }
                let released = false;
                return { release() {
                    if (released) return;
                    // Only this lease can remove its own directory.
                    fs.unlinkSync(path.join(dir, nonce)); fs.rmdirSync(dir); released = true;
                } };
            }
            return null;
    }
    return {
        acquire(units = 1) {
            if (!Number.isInteger(units) || units < 1 || units > limit) return null;
            const leases = [];
            for (let i = 0; i < units; i++) {
                const lease = acquireOne();
                if (!lease) { for (const held of leases) held.release(); return null; }
                leases.push(lease);
            }
            return { units, release() { for (const held of leases) held.release(); } };
        },
        snapshot() { return { limit, occupied: fs.readdirSync(root).filter(n => /^slot-\d+$/.test(n)).length }; },
    };
}
module.exports = { createSharedEncoderSlots, encoderSlotWeight };
