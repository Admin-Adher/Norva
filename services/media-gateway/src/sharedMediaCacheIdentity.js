'use strict';

const {
    MediaCacheIdentityError,
    normalizeGlobalMediaObjectIdentity,
} = require('./mediaCacheIdentity');

class SharedMediaCacheIdentityError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'SharedMediaCacheIdentityError';
        this.code = code;
    }
}

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function first(value, ...aliases) {
    if (value !== undefined && value !== null) return value;
    return aliases.find((candidate) => candidate !== undefined && candidate !== null);
}

function exactInteger(value, field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new SharedMediaCacheIdentityError('SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE', `${field} is unavailable`);
    }
    return number;
}

function exactNumber(value, field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new SharedMediaCacheIdentityError('SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE', `${field} is unavailable`);
    }
    return number;
}

function boundedText(value, field, maximum, nullable = false) {
    if (value === null || value === undefined || String(value).trim() === '') {
        if (nullable) return null;
        throw new SharedMediaCacheIdentityError('SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE', `${field} is unavailable`);
    }
    const text = String(value).trim();
    if (text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new SharedMediaCacheIdentityError('SHARED_MEDIA_CACHE_PROFILE_INVALID', `${field} is invalid`);
    }
    return text;
}

function languageTag(value) {
    const text = String(value || 'und').trim().toLowerCase().replaceAll('_', '-');
    return /^[a-z0-9]{2,8}(?:-[a-z0-9]{1,8})*$/.test(text) ? text : 'und';
}

function topologyArray(profile, primary, ...aliases) {
    const candidate = first(profile[primary], ...aliases.map((alias) => profile[alias]));
    if (!Array.isArray(candidate)) {
        throw new SharedMediaCacheIdentityError(
            'SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE',
            `${primary} is unavailable`,
        );
    }
    return candidate;
}

function normalizeAudioTopology(profile) {
    return topologyArray(profile, 'audioTracks', 'audio_tracks').map((raw, position) => {
        const track = record(raw);
        return {
            streamIndex: exactInteger(first(track.index, track.streamIndex, track.stream_index), `audioTracks[${position}].index`, 0, 4095),
            codec: boundedText(first(track.codec, track.codecName, track.codec_name), `audioTracks[${position}].codec`, 64).toLowerCase(),
            language: languageTag(first(track.language, track.lang)),
            channels: exactInteger(track.channels, `audioTracks[${position}].channels`, 1, 64),
            sampleRate: exactInteger(first(track.sampleRate, track.sample_rate), `audioTracks[${position}].sampleRate`, 1, 768_000),
            title: boundedText(track.title, `audioTracks[${position}].title`, 512, true),
            default: track.default === true,
            forced: track.forced === true,
        };
    });
}

function normalizeSubtitleTopology(profile) {
    return topologyArray(profile, 'subtitles', 'subtitleTracks', 'subtitle_tracks').map((raw, position) => {
        const track = record(raw);
        return {
            streamIndex: exactInteger(first(track.index, track.streamIndex, track.stream_index), `subtitles[${position}].index`, 0, 4095),
            codec: boundedText(first(track.codec, track.codecName, track.codec_name), `subtitles[${position}].codec`, 64).toLowerCase(),
            language: languageTag(first(track.language, track.lang)),
            title: boundedText(track.title, `subtitles[${position}].title`, 512, true),
            default: track.default === true,
            forced: track.forced === true,
            hearingImpaired: track.hearingImpaired === true || track.hearing_impaired === true,
        };
    });
}

function buildSharedMediaCacheIdentity(options = {}) {
    const profile = record(options.codecProfile);
    if (profile.metadataComplete !== true && profile.metadata_complete !== true) {
        throw new SharedMediaCacheIdentityError(
            'SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE',
            'the exact-file profile is not complete',
        );
    }
    const durationSeconds = exactNumber(
        first(profile.durationSeconds, profile.duration_seconds, profile.duration),
        'durationSeconds',
        0.001,
        24 * 60 * 60,
    );
    const durationMilliseconds = Math.round(durationSeconds * 1000);
    if (!Number.isSafeInteger(durationMilliseconds) || durationMilliseconds <= 0) {
        throw new SharedMediaCacheIdentityError('SHARED_MEDIA_CACHE_PROFILE_INVALID', 'duration is invalid');
    }
    const identity = {
        contentSha256: boundedText(options.contentSha256, 'contentSha256', 64).toLowerCase(),
        fileSizeBytes: exactInteger(
            first(options.fileSizeBytes, profile.fileSizeBytes, profile.file_size_bytes),
            'fileSizeBytes',
            1,
        ),
        videoProfile: {
            streamIndex: exactInteger(first(profile.videoStreamIndex, profile.video_stream_index), 'videoStreamIndex', 0, 4095),
            codec: boundedText(first(profile.videoCodec, profile.video_codec, profile.video), 'videoCodec', 64).toLowerCase(),
            profile: boundedText(first(profile.videoProfile, profile.video_profile), 'videoProfile', 128, true)?.toLowerCase() ?? null,
            level: first(profile.videoLevel, profile.video_level) == null
                ? null
                : exactInteger(first(profile.videoLevel, profile.video_level), 'videoLevel', 0, 10_000),
            width: exactInteger(first(profile.videoWidth, profile.video_width, profile.width), 'videoWidth', 1, 32_768),
            height: exactInteger(first(profile.videoHeight, profile.video_height, profile.height), 'videoHeight', 1, 32_768),
            pixelFormat: boundedText(first(profile.videoPixelFormat, profile.video_pixel_format, profile.pix_fmt), 'videoPixelFormat', 64, true)?.toLowerCase() ?? null,
            frameRateNumerator: exactInteger(first(profile.videoFrameRateNumerator, profile.video_frame_rate_numerator), 'videoFrameRateNumerator', 1, 1_000_000),
            frameRateDenominator: exactInteger(first(profile.videoFrameRateDenominator, profile.video_frame_rate_denominator), 'videoFrameRateDenominator', 1, 1_000_000),
        },
        audioTopology: normalizeAudioTopology(profile),
        subtitleTopology: normalizeSubtitleTopology(profile),
        durationMilliseconds,
        pipelineBuild: boundedText(options.pipelineBuild, 'pipelineBuild', 256),
        segmenterBuild: boundedText(options.segmenterBuild, 'segmenterBuild', 256),
    };
    if (!identity.audioTopology.length) {
        throw new SharedMediaCacheIdentityError(
            'SHARED_MEDIA_CACHE_PROFILE_INCOMPLETE',
            'at least one exact audio track is required',
        );
    }
    try {
        return Object.freeze(normalizeGlobalMediaObjectIdentity(identity));
    } catch (error) {
        if (error instanceof MediaCacheIdentityError) {
            throw new SharedMediaCacheIdentityError(
                'SHARED_MEDIA_CACHE_PROFILE_INVALID',
                'the exact-file cache identity is invalid',
                { cause: error },
            );
        }
        throw error;
    }
}

module.exports = {
    SharedMediaCacheIdentityError,
    buildSharedMediaCacheIdentity,
};
