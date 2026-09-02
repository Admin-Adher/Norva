'use strict';

const crypto = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timingSafeTextEqual(leftValue, rightValue) {
    const left = Buffer.from(String(leftValue || ''), 'utf8');
    const right = Buffer.from(String(rightValue || ''), 'utf8');
    if (left.length !== right.length || left.length === 0) return false;
    return crypto.timingSafeEqual(left, right);
}

function createViewerAttachmentRegistry(options = {}) {
    const maximum = Math.max(1, Math.min(256, Number(options.maximum) || 64));
    const tokenFactory = typeof options.tokenFactory === 'function'
        ? options.tokenFactory
        : () => crypto.randomBytes(32).toString('base64url');
    const clock = typeof options.now === 'function' ? options.now : Date.now;
    const entries = new Map();
    const issuedTokens = new Set();

    function prune(nowMs = clock()) {
        let removed = 0;
        for (const [attachmentId, entry] of entries) {
            if (entry.expiresAtMs <= nowMs) {
                entries.delete(attachmentId);
                issuedTokens.delete(entry.token);
                removed += 1;
            }
        }
        return removed;
    }

    function attach(value = {}) {
        const attachmentId = String(value.attachmentId || '').toLowerCase();
        const playbackSessionId = String(value.playbackSessionId || '').toLowerCase();
        const expiresAtMs = Date.parse(String(value.expiresAt || ''));
        const nowMs = clock();
        if (!UUID_PATTERN.test(attachmentId) || !UUID_PATTERN.test(playbackSessionId)) {
            const error = new TypeError('MEDIA_CACHE_LIVE_ATTACHMENT_ID_INVALID');
            error.code = 'MEDIA_CACHE_LIVE_ATTACHMENT_ID_INVALID';
            throw error;
        }
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + 5_000 || expiresAtMs > nowMs + 8 * 60 * 60 * 1_000) {
            const error = new TypeError('MEDIA_CACHE_LIVE_ATTACHMENT_EXPIRY_INVALID');
            error.code = 'MEDIA_CACHE_LIVE_ATTACHMENT_EXPIRY_INVALID';
            throw error;
        }
        prune(nowMs);
        const existing = entries.get(attachmentId);
        if (existing) {
            if (existing.playbackSessionId !== playbackSessionId || existing.expiresAtMs !== expiresAtMs) {
                const error = new Error('MEDIA_CACHE_LIVE_ATTACHMENT_CONFLICT');
                error.code = 'MEDIA_CACHE_LIVE_ATTACHMENT_CONFLICT';
                throw error;
            }
            return { ...existing, idempotent: true };
        }
        if (entries.size >= maximum) {
            const error = new Error('MEDIA_CACHE_LIVE_ATTACHMENT_CAPACITY');
            error.code = 'MEDIA_CACHE_LIVE_ATTACHMENT_CAPACITY';
            throw error;
        }
        let token = '';
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const candidate = String(tokenFactory() || '');
            if (
                candidate.length >= 32 && candidate.length <= 512 &&
                !/[\u0000-\u0020\u007f]/.test(candidate) &&
                !issuedTokens.has(candidate)
            ) {
                token = candidate;
                break;
            }
        }
        if (!token) {
            const error = new Error('MEDIA_CACHE_LIVE_ATTACHMENT_TOKEN_INVALID');
            error.code = 'MEDIA_CACHE_LIVE_ATTACHMENT_TOKEN_INVALID';
            throw error;
        }
        const entry = Object.freeze({
            attachmentId,
            playbackSessionId,
            token,
            expiresAtMs,
            createdAtMs: nowMs,
        });
        entries.set(attachmentId, entry);
        issuedTokens.add(token);
        return { ...entry, idempotent: false };
    }

    function authorize(tokenValue, nowMs = clock()) {
        const token = String(tokenValue || '');
        if (!token) return null;
        prune(nowMs);
        for (const entry of entries.values()) {
            if (timingSafeTextEqual(token, entry.token)) return entry;
        }
        return null;
    }

    function revoke(attachmentIdValue, playbackSessionIdValue = null) {
        const attachmentId = String(attachmentIdValue || '').toLowerCase();
        const entry = entries.get(attachmentId);
        if (!entry) return null;
        const playbackSessionId = playbackSessionIdValue === null
            ? null
            : String(playbackSessionIdValue || '').toLowerCase();
        if (playbackSessionId && entry.playbackSessionId !== playbackSessionId) return null;
        entries.delete(attachmentId);
        issuedTokens.delete(entry.token);
        return entry;
    }

    function clear() {
        const count = entries.size;
        entries.clear();
        issuedTokens.clear();
        return count;
    }

    function snapshot(nowMs = clock()) {
        prune(nowMs);
        return Object.freeze({
            count: entries.size,
            maximum,
            earliestExpiryAt: entries.size
                ? new Date(Math.min(...Array.from(entries.values(), (entry) => entry.expiresAtMs))).toISOString()
                : null,
        });
    }

    return Object.freeze({ attach, authorize, revoke, prune, clear, snapshot });
}

module.exports = Object.freeze({
    UUID_PATTERN,
    createViewerAttachmentRegistry,
    timingSafeTextEqual,
});
