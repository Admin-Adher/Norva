'use strict';

const path = require('node:path');

const PROTOCOL = 1;
const FIXTURE_IDS = Object.freeze([
    'h264-closed-aac',
    'h264-closed-ac3',
    'h264-open-gop',
    'h264-multi-audio',
    'hevc-eac3-cold',
    'h264-level52',
    'h264-bad-timestamps',
    'h264-pgs',
    'h264-no-etag',
    'hevc-full-cache',
    'provider-458',
]);

const DEFINITIONS = [
    definition('h264-closed-aac', 'h264-closed-aac.mkv', 'video-copy-audio-copy', 'mkv-h264-copy-ready', true, { trainingRequired: true }),
    definition('h264-closed-ac3', 'h264-closed-ac3.mkv', 'video-copy-audio-transcode', 'mkv-h264-copy-ready', true, { trainingRequired: true }),
    definition('h264-open-gop', 'h264-open-gop.mkv', 'video-transcode', 'open-gop', true, {}, 'vaapi-transcode-ready'),
    definition('h264-multi-audio', 'h264-multi-audio.mkv', 'video-transcode', 'multi-audio', true, {}, 'vaapi-transcode-ready'),
    definition('hevc-eac3-cold', 'hevc-eac3-cold.mkv', 'video-transcode', 'video-codec', true, { delayMs: 750 }, 'vaapi-transcode-ready'),
    definition('h264-level52', 'h264-level52.mkv', 'video-transcode', 'web-compatibility', true, {}, [
        'vaapi-transcode-ready',
        'encode-rate-below-minimum',
    ]),
    definition('h264-bad-timestamps', 'h264-bad-timestamps.mkv', 'video-transcode', 'invalid-timestamps', true, {}, 'vaapi-transcode-ready'),
    definition('h264-pgs', 'h264-pgs.mkv', 'video-copy-audio-copy', 'mkv-h264-copy-ready', true, { trainingRequired: true }),
    definition('h264-no-etag', 'h264-no-etag.mkv', 'video-transcode', 'strong-etag-required', true, { etag: 'weak' }, 'vaapi-transcode-ready'),
    definition('hevc-full-cache', 'hevc-full-cache.mkv', 'cache-hit', 'complete-cache-hit', true, {
        providerExpected: false,
        seedBeforeMeasure: true,
    }, 'complete-hls-cache-hit'),
    definition('provider-458', null, 'terminal-458', 'provider-busy-terminal', false, {
        first458: true,
        assetRequired: false,
    }),
];

function definition(id, assetFile, pipeline, reason, under10Seconds, provider = {}, runtimeReason = reason) {
    const providerExpected = provider.providerExpected !== false;
    const trainingRequired = provider.trainingRequired === true;
    const seedBeforeMeasure = provider.seedBeforeMeasure === true;
    const first458 = provider.first458 === true;
    const expectedGets = seedBeforeMeasure ? 0 : (first458 ? 1 : (trainingRequired ? 2 : (providerExpected ? 1 : 0)));
    const runtimeReasons = Object.freeze(Array.isArray(runtimeReason) ? [...runtimeReason] : [runtimeReason]);
    return Object.freeze({
        id,
        assetFile,
        expected: Object.freeze({
            pipeline,
            reason,
            runtimeReason: runtimeReasons[0],
            runtimeReasons,
            under10Seconds,
        }),
        provider: Object.freeze({
            etag: provider.etag || 'strong',
            delayMs: Number.isInteger(provider.delayMs) ? provider.delayMs : 0,
            first458,
            providerExpected,
            trainingRequired,
            seedBeforeMeasure,
            expectedGets,
            assetRequired: provider.assetRequired !== false,
        }),
    });
}

if (
    DEFINITIONS.length !== FIXTURE_IDS.length
    || DEFINITIONS.some((item, index) => item.id !== FIXTURE_IDS[index])
    || new Set(FIXTURE_IDS).size !== FIXTURE_IDS.length
) {
    throw new Error('MEDIA_LAB_FIXED_FIXTURE_REGISTRY_INVALID');
}

const BY_ID = new Map(DEFINITIONS.map((item) => [item.id, item]));

class RequestValidationError extends Error {
    constructor(code) {
        super(code);
        this.name = 'RequestValidationError';
        this.code = code;
    }
}

function parseRunRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestValidationError('INVALID_RUN_REQUEST');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new RequestValidationError('INVALID_RUN_REQUEST');
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'fixtureId' || keys[1] !== 'protocol') {
        throw new RequestValidationError('INVALID_RUN_REQUEST');
    }
    if (value.protocol !== PROTOCOL || typeof value.fixtureId !== 'string') {
        throw new RequestValidationError('INVALID_RUN_REQUEST');
    }
    const fixture = BY_ID.get(value.fixtureId);
    if (!fixture) throw new RequestValidationError('UNKNOWN_LAB_FIXTURE');
    return fixture;
}

function fixtureAssetPath(fixtureRoot, fixture) {
    if (!fixture.assetFile) return null;
    const root = path.resolve(fixtureRoot);
    const resolved = path.resolve(root, fixture.assetFile);
    if (path.dirname(resolved) !== root) throw new Error('MEDIA_LAB_FIXTURE_PATH_INVALID');
    return resolved;
}

module.exports = Object.freeze({
    PROTOCOL,
    FIXTURE_IDS,
    FIXTURES: Object.freeze(DEFINITIONS),
    RequestValidationError,
    parseRunRequest,
    fixtureAssetPath,
});
