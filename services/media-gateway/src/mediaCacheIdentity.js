'use strict';

const crypto = require('node:crypto');

const GLOBAL_MEDIA_OBJECT_SCHEMA = 1;
const MEDIA_CACHE_BINDING_SCHEMA = 1;
const MAX_AUDIO_TRACKS = 64;
const MAX_SUBTITLE_TRACKS = 128;

class MediaCacheIdentityError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'MediaCacheIdentityError';
        this.code = code;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function canonicalMediaJson(value, depth = 0) {
    if (depth > 24) throw invalid('media cache identity is too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => canonicalMediaJson(item, depth + 1)).join(',')}]`;
    if (!isPlainObject(value)) throw invalid('media cache identity contains a non-JSON value');
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalMediaJson(value[key], depth + 1)}`).join(',')}}`;
}

function invalid(message) {
    return new MediaCacheIdentityError('INVALID_MEDIA_CACHE_IDENTITY', message);
}

function exactKeys(value, keys, field) {
    if (!isPlainObject(value)) throw invalid(`${field} must be an object`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw invalid(`${field} has an unexpected shape`);
    }
}

function exactSha256(value, field) {
    const digest = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(digest)) throw invalid(`${field} must be an exact SHA-256 digest`);
    return digest;
}

function boundedString(value, field, maxLength = 256, lowerCase = false) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
        throw invalid(`${field} is invalid`);
    }
    return lowerCase ? normalized.toLowerCase() : normalized;
}

function nullableBoundedString(value, field, maxLength = 256, lowerCase = false) {
    if (value === null) return null;
    return boundedString(value, field, maxLength, lowerCase);
}

function safeInteger(value, field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw invalid(`${field} is invalid`);
    }
    return number;
}

function exactBoolean(value, field) {
    if (typeof value !== 'boolean') throw invalid(`${field} must be a boolean`);
    return value;
}

function normalizedLanguage(value, field) {
    const language = boundedString(value, field, 35, true).replaceAll('_', '-');
    if (!/^[a-z0-9]{2,8}(?:-[a-z0-9]{1,8})*$/.test(language)) throw invalid(`${field} is invalid`);
    return language;
}

function normalizeVideoProfile(value) {
    const keys = [
        'streamIndex', 'codec', 'profile', 'level', 'width', 'height',
        'pixelFormat', 'frameRateNumerator', 'frameRateDenominator',
    ];
    exactKeys(value, keys, 'videoProfile');
    return {
        streamIndex: safeInteger(value.streamIndex, 'videoProfile.streamIndex', 0, 4095),
        codec: boundedString(value.codec, 'videoProfile.codec', 64, true),
        profile: nullableBoundedString(value.profile, 'videoProfile.profile', 128, true),
        level: value.level === null ? null : safeInteger(value.level, 'videoProfile.level', 0, 10_000),
        width: safeInteger(value.width, 'videoProfile.width', 1, 32_768),
        height: safeInteger(value.height, 'videoProfile.height', 1, 32_768),
        pixelFormat: nullableBoundedString(value.pixelFormat, 'videoProfile.pixelFormat', 64, true),
        frameRateNumerator: safeInteger(value.frameRateNumerator, 'videoProfile.frameRateNumerator', 1, 1_000_000),
        frameRateDenominator: safeInteger(value.frameRateDenominator, 'videoProfile.frameRateDenominator', 1, 1_000_000),
    };
}

function normalizeAudioTrack(value, position) {
    const field = `audioTopology[${position}]`;
    exactKeys(value, ['streamIndex', 'codec', 'language', 'channels', 'sampleRate', 'title', 'default', 'forced'], field);
    return {
        streamIndex: safeInteger(value.streamIndex, `${field}.streamIndex`, 0, 4095),
        codec: boundedString(value.codec, `${field}.codec`, 64, true),
        language: normalizedLanguage(value.language, `${field}.language`),
        channels: safeInteger(value.channels, `${field}.channels`, 1, 64),
        sampleRate: safeInteger(value.sampleRate, `${field}.sampleRate`, 1, 768_000),
        title: nullableBoundedString(value.title, `${field}.title`, 512),
        default: exactBoolean(value.default, `${field}.default`),
        forced: exactBoolean(value.forced, `${field}.forced`),
    };
}

function normalizeSubtitleTrack(value, position) {
    const field = `subtitleTopology[${position}]`;
    exactKeys(value, ['streamIndex', 'codec', 'language', 'title', 'default', 'forced', 'hearingImpaired'], field);
    return {
        streamIndex: safeInteger(value.streamIndex, `${field}.streamIndex`, 0, 4095),
        codec: boundedString(value.codec, `${field}.codec`, 64, true),
        language: normalizedLanguage(value.language, `${field}.language`),
        title: nullableBoundedString(value.title, `${field}.title`, 512),
        default: exactBoolean(value.default, `${field}.default`),
        forced: exactBoolean(value.forced, `${field}.forced`),
        hearingImpaired: exactBoolean(value.hearingImpaired, `${field}.hearingImpaired`),
    };
}

function normalizeTrackTopology(value, field, limit, normalizeTrack) {
    if (!Array.isArray(value) || value.length > limit) throw invalid(`${field} exceeds its structural bound`);
    const tracks = value.map(normalizeTrack).sort((left, right) => left.streamIndex - right.streamIndex);
    for (let index = 1; index < tracks.length; index += 1) {
        if (tracks[index - 1].streamIndex === tracks[index].streamIndex) {
            throw invalid(`${field} contains duplicate stream indexes`);
        }
    }
    return tracks;
}

function normalizeGlobalMediaObjectIdentity(identity) {
    const keys = [
        'contentSha256', 'fileSizeBytes', 'videoProfile', 'audioTopology',
        'subtitleTopology', 'durationMilliseconds', 'pipelineBuild', 'segmenterBuild',
    ];
    exactKeys(identity, keys, 'global media object identity');
    return {
        contentSha256: exactSha256(identity.contentSha256, 'contentSha256'),
        fileSizeBytes: safeInteger(identity.fileSizeBytes, 'fileSizeBytes', 1),
        videoProfile: normalizeVideoProfile(identity.videoProfile),
        audioTopology: normalizeTrackTopology(identity.audioTopology, 'audioTopology', MAX_AUDIO_TRACKS, normalizeAudioTrack),
        subtitleTopology: normalizeTrackTopology(identity.subtitleTopology, 'subtitleTopology', MAX_SUBTITLE_TRACKS, normalizeSubtitleTrack),
        durationMilliseconds: safeInteger(identity.durationMilliseconds, 'durationMilliseconds', 1),
        pipelineBuild: boundedString(identity.pipelineBuild, 'pipelineBuild', 256),
        segmenterBuild: boundedString(identity.segmenterBuild, 'segmenterBuild', 256),
    };
}

function deriveGlobalMediaCacheObjectKey(identity) {
    const normalized = normalizeGlobalMediaObjectIdentity(identity);
    const components = {
        content: normalized.contentSha256,
        size: sha256(`size\0${normalized.fileSizeBytes}`),
        video: sha256(`video\0${canonicalMediaJson(normalized.videoProfile)}`),
        audio: sha256(`audio\0${canonicalMediaJson(normalized.audioTopology)}`),
        subtitles: sha256(`subtitles\0${canonicalMediaJson(normalized.subtitleTopology)}`),
        duration: sha256(`duration-ms\0${normalized.durationMilliseconds}`),
        pipeline: sha256(`pipeline\0${normalized.pipelineBuild}`),
        segmenter: sha256(`segmenter\0${normalized.segmenterBuild}`),
    };
    return {
        key: sha256(canonicalMediaJson({
            schema: GLOBAL_MEDIA_OBJECT_SCHEMA,
            namespace: 'norva-global-media-object',
            components,
        })),
        components,
        schema: GLOBAL_MEDIA_OBJECT_SCHEMA,
        identityKind: 'global-media-object',
    };
}

function normalizeMediaCacheBindingIdentity(binding) {
    const keys = [
        'tenantScopeSha256', 'sourceScopeSha256', 'mediaItemScopeSha256',
        'variantScopeSha256', 'itemType', 'targetUrlSha256',
    ];
    exactKeys(binding, keys, 'media cache binding identity');
    const itemType = boundedString(binding.itemType, 'itemType', 16, true);
    if (!['movie', 'episode'].includes(itemType)) throw invalid('itemType is not cacheable');
    return {
        tenantScopeSha256: exactSha256(binding.tenantScopeSha256, 'tenantScopeSha256'),
        sourceScopeSha256: exactSha256(binding.sourceScopeSha256, 'sourceScopeSha256'),
        mediaItemScopeSha256: exactSha256(binding.mediaItemScopeSha256, 'mediaItemScopeSha256'),
        variantScopeSha256: binding.variantScopeSha256 === null
            ? null
            : exactSha256(binding.variantScopeSha256, 'variantScopeSha256'),
        itemType,
        targetUrlSha256: exactSha256(binding.targetUrlSha256, 'targetUrlSha256'),
    };
}

function deriveMediaCacheBindingKey(binding, objectKey) {
    const normalized = normalizeMediaCacheBindingIdentity(binding);
    const normalizedObjectKey = exactSha256(objectKey, 'objectKey');
    const components = {
        tenant: normalized.tenantScopeSha256,
        source: normalized.sourceScopeSha256,
        mediaItem: normalized.mediaItemScopeSha256,
        variant: normalized.variantScopeSha256 || sha256('variant\0<null>'),
        itemType: sha256(`item-type\0${normalized.itemType}`),
        targetUrl: normalized.targetUrlSha256,
    };
    return {
        key: sha256(canonicalMediaJson({
            schema: MEDIA_CACHE_BINDING_SCHEMA,
            namespace: 'norva-media-cache-binding',
            components,
        })),
        objectKey: normalizedObjectKey,
        components,
        schema: MEDIA_CACHE_BINDING_SCHEMA,
        identityKind: 'media-cache-binding',
    };
}

module.exports = {
    GLOBAL_MEDIA_OBJECT_SCHEMA,
    MEDIA_CACHE_BINDING_SCHEMA,
    MediaCacheIdentityError,
    canonicalMediaJson,
    deriveGlobalMediaCacheObjectKey,
    deriveMediaCacheBindingKey,
    normalizeGlobalMediaObjectIdentity,
    normalizeMediaCacheBindingIdentity,
};
