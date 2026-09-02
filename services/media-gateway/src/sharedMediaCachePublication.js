'use strict';

const { buildSharedMediaCacheIdentity } = require('./sharedMediaCacheIdentity');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class SharedMediaCachePublicationError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'SharedMediaCachePublicationError';
        this.code = code;
        this.retryable = options.retryable === true;
    }
}

function exactPublicationResult(value) {
    const result = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const components = result.components && typeof result.components === 'object' && !Array.isArray(result.components)
        ? result.components
        : {};
    if (!['published', 'already-ready'].includes(result.status)
        || !SHA256_PATTERN.test(String(result.objectKey || ''))
        || !SHA256_PATTERN.test(String(result.manifestSha256 || ''))
        || !SHA256_PATTERN.test(String(components.video || ''))
        || !SHA256_PATTERN.test(String(components.audio || ''))
        || !SHA256_PATTERN.test(String(components.subtitles || ''))
        || !Number.isSafeInteger(result.totalBytes) || result.totalBytes <= 0
        || !Number.isSafeInteger(result.fileCount) || result.fileCount <= 0 || result.fileCount > 20_000
        || !Number.isSafeInteger(result.expiresAtMs) || result.expiresAtMs <= Date.now()
        || typeof result.objectPrefix !== 'string'
        || result.objectPrefix !== `media-cache/v1/${result.objectKey.slice(0, 2)}/${result.objectKey}/`) {
        throw new SharedMediaCachePublicationError(
            'SHARED_MEDIA_CACHE_PUBLICATION_INVALID',
            'the shared object publication result is invalid',
        );
    }
    return { result, components };
}

async function publishSharedMediaCacheSession(options = {}) {
    const session = options.session && typeof options.session === 'object' ? options.session : {};
    if (!UUID_PATTERN.test(String(session.id || ''))
        || !UUID_PATTERN.test(String(session.playbackSessionId || ''))
        || session.inputPump?.completed !== true
        || session.completeHlsCacheFfmpegCompletedCleanly !== true
        || session.inputFailure || session.lastError) {
        throw new SharedMediaCachePublicationError(
            'SHARED_MEDIA_CACHE_SESSION_INCOMPLETE',
            'only one clean EOF-complete Gateway session may be published',
        );
    }
    if (!options.publisher || typeof options.publisher.publish !== 'function'
        || typeof options.registerPublication !== 'function') {
        throw new SharedMediaCachePublicationError(
            'SHARED_MEDIA_CACHE_CONFIG_INVALID',
            'shared media cache publication is not configured',
        );
    }
    const identity = buildSharedMediaCacheIdentity({
        contentSha256: session.vodInputContentSha256,
        fileSizeBytes: session.fileSizeBytes ?? session.codecProfile?.fileSizeBytes ?? session.codecProfile?.file_size_bytes,
        codecProfile: session.codecProfile,
        pipelineBuild: options.pipelineBuild,
        segmenterBuild: options.segmenterBuild,
    });
    const published = await options.publisher.publish({
        identity,
        sourceDirectory: options.sourceDirectory,
        rootPlaylist: options.rootPlaylist,
        files: options.files,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
        completion: { kind: 'complete-hls', sourceEof: true, ffmpegExitCode: 0 },
    });
    const { result, components } = exactPublicationResult(published);
    const callback = await options.registerPublication({
        protocol: 1,
        status: 'ready',
        playbackSessionId: String(session.playbackSessionId).toLowerCase(),
        gatewaySessionId: String(session.id).toLowerCase(),
        object: {
            objectKey: result.objectKey,
            contentSha256: identity.contentSha256,
            fileSizeBytes: identity.fileSizeBytes,
            videoProfileSha256: components.video,
            audioTopologySha256: components.audio,
            subtitleTopologySha256: components.subtitles,
            durationMilliseconds: identity.durationMilliseconds,
            pipelineBuild: identity.pipelineBuild,
            segmenterBuild: identity.segmenterBuild,
            storageBackend: 'r2',
            rootPlaylist: options.rootPlaylist,
            manifestSha256: result.manifestSha256,
            totalBytes: result.totalBytes,
            fileCount: result.fileCount,
            expiresAt: new Date(result.expiresAtMs).toISOString(),
        },
    });
    if (!callback || callback.ok !== true
        || callback.objectKey !== result.objectKey
        || !UUID_PATTERN.test(String(callback.bindingId || ''))) {
        throw new SharedMediaCachePublicationError(
            'SHARED_MEDIA_CACHE_REGISTRATION_FAILED',
            'the shared object could not be bound to exact playback authority',
            { retryable: true },
        );
    }
    return Object.freeze({
        status: result.status,
        objectKey: result.objectKey,
        bindingId: String(callback.bindingId).toLowerCase(),
        manifestSha256: result.manifestSha256,
        totalBytes: result.totalBytes,
        fileCount: result.fileCount,
        expiresAt: new Date(result.expiresAtMs).toISOString(),
    });
}

module.exports = {
    SharedMediaCachePublicationError,
    publishSharedMediaCacheSession,
};
