const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadEngineClass() {
    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const sandbox = {
        window: {},
        document: { createElement: () => ({}) },
        navigator: { userAgent: 'node-test' },
        performance,
        console,
        URL,
        fetch,
        AbortController,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        TextDecoder,
        crypto,
    };
    sandbox.self = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'norvaEngine.js' });
    return sandbox.window.NorvaEngine;
}

function exactH264MkvProfile(overrides = {}) {
    return {
        videoCodec: 'h264',
        audioCodec: 'aac',
        videoWidth: 1920,
        videoHeight: 1080,
        audioChannels: 2,
        audioSampleRate: 48000,
        audioTracks: [{ index: 1, codec: 'aac', channels: 2 }],
        subtitles: [],
        container: 'matroska,webm',
        durationSeconds: 5400,
        bitRate: 2_560_000,
        probeSource: 'gateway_probe',
        probeMs: 1200,
        probedAt: '2026-08-15T00:00:00.000Z',
        ...overrides,
    };
}

// Minimal valid AVCDecoderConfigurationRecord: one SPS (NAL type 7) + one PPS
// (NAL type 8). The payload bytes need not decode for this header-validation test.
const AVC_C = new Uint8Array([
    1, 100, 0, 40, 0xff, 0xe1,
    0, 4, 0x67, 0x64, 0, 0x28,
    1, 0, 2, 0x68, 0xee,
]);
const AAC_ASC = new Uint8Array([0x11, 0x90]); // AAC-LC, 48 kHz, stereo

function makeLib({
    incompleteBeforeFind = false,
    emptyBeforeFind = false,
    actualVideo = 'h264',
    actualAudio = 'aac',
    secondAudio = 'aac',
    includeSecondAudio = false,
    includeSubtitle = false,
    subtitleTimeBaseDen = 1000,
    formatDurationUs = 0,
    findError = null,
    findReturn = 0,
} = {}) {
    const calls = [];
    let foundInfo = false;
    const streams = [101, 102];
    if (includeSecondAudio) streams.push(104);
    if (includeSubtitle) streams.push(103);
    const codecpars = new Map([[101, 201], [102, 202], [103, 203], [104, 204]]);
    const audioCodecId = actualAudio === 'ac3' ? 86019 : actualAudio === 'eac3' ? 86056 : 86018;
    const secondAudioCodecId = secondAudio === 'ac3' ? 86019 : secondAudio === 'eac3' ? 86056 : 86018;

    const lib = {
        calls,
        async mkblockreaderdev(name, size) { calls.push(['mkblockreaderdev', name, size]); },
        async avformat_open_input_js(name, fmt, options) {
            calls.push(['avformat_open_input_js', name, fmt, options]);
            return 11;
        },
        async avformat_find_stream_info(fmtCtx, options) {
            calls.push(['avformat_find_stream_info', fmtCtx, options]);
            if (findError) throw findError;
            foundInfo = true;
            return findReturn;
        },
        async ff_init_demuxer_file(name) {
            calls.push(['ff_init_demuxer_file', name]);
            return [22, [{ ptr: 301, index: 0, codecpar: 401, codec_type: 0, codec_id: 27, time_base_num: 1, time_base_den: 1000, duration_time_base: 5000, duration: 5 }]];
        },
        async AVFormatContext_nb_streams() { return emptyBeforeFind && !foundInfo ? 0 : streams.length; },
        async AVFormatContext_streams_a(_ctx, index) { return streams[index]; },
        async AVStream_codecpar(stream) { return codecpars.get(stream); },
        async AVCodecParameters_codec_type(codecpar) { return codecpar === 201 ? 0 : codecpar === 203 ? 3 : 1; },
        async AVCodecParameters_codec_id(codecpar) {
            return codecpar === 201 ? 27 : codecpar === 203 ? 94225 : codecpar === 204 ? secondAudioCodecId : audioCodecId;
        },
        async AVStream_time_base_num() { return 1; },
        async AVStream_time_base_den(stream) { return stream === 103 ? subtitleTimeBaseDen : 1000; },
        async AVStream_duration() { return 5_400_000; },
        async AVStream_durationhi() { return 0; },
        async avcodec_get_name(codecId) {
            if (codecId === 27) return actualVideo;
            if (codecId === 94225) return 'subrip';
            if (codecId === secondAudioCodecId && codecId !== audioCodecId) return secondAudio;
            return actualAudio;
        },
        async ff_copyout_codecpar(codecpar) {
            if (codecpar === 201) {
                return {
                    codec_id: 27,
                    width: incompleteBeforeFind && !foundInfo ? 0 : 1920,
                    height: incompleteBeforeFind && !foundInfo ? 0 : 1080,
                    extradata: incompleteBeforeFind && !foundInfo ? null : AVC_C,
                };
            }
            return {
                codec_id: 86018,
                sample_rate: incompleteBeforeFind && !foundInfo ? 0 : 48000,
                channels: incompleteBeforeFind && !foundInfo ? 0 : 2,
                extradata: incompleteBeforeFind && !foundInfo ? null : AAC_ASC,
            };
        },
        async AVFormatContext_duration() { return formatDurationUs; },
        async AVFormatContext_durationhi() { return 0; },
    };
    return lib;
}

function makeEngine(profile, lib) {
    const NorvaEngine = loadEngineClass();
    const engine = new NorvaEngine({}, { codecProfile: profile });
    engine.url = 'https://media.invalid/title.mkv';
    engine.size = 64 * 1024 * 1024;
    engine.lib = lib;
    engine._raCache = [{
        start: 0,
        end: 8,
        buf: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88]),
    }];
    engine._diag = {};
    engine.timings = {};
    return engine;
}

test('exact H264 Matroska fast-open uses header codecpars and skips stream-info probing', async () => {
    const lib = makeLib({ actualAudio: 'ac3' });
    const engine = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }],
    }), lib);

    await engine._openInput();

    assert.strictEqual(engine.fmtCtx, 11);
    assert.strictEqual(engine._streams.length, 2);
    assert.deepStrictEqual(
        lib.calls.filter(([name]) => name === 'avformat_open_input_js'),
        [['avformat_open_input_js', 'input', null, null]],
    );
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 0);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
    assert.strictEqual(engine.durationSec, 5400, 'an exact profile may fill only missing header duration');
    assert.strictEqual(engine.timings.demuxFastOpen, true);
    assert.strictEqual(engine.timings.demuxStreamInfoFallback, false);
});

test('an incomplete direct header falls back to find_stream_info on the same context without reopening', async () => {
    const lib = makeLib({ incompleteBeforeFind: true });
    const engine = makeEngine(exactH264MkvProfile(), lib);

    await engine._openInput();

    assert.deepStrictEqual(
        lib.calls.filter(([name]) => name === 'avformat_open_input_js'),
        [['avformat_open_input_js', 'input', null, null]],
    );
    assert.deepStrictEqual(
        lib.calls.filter(([name]) => name === 'avformat_find_stream_info'),
        [['avformat_find_stream_info', 11, 0]],
    );
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0,
        'fallback must not reopen the block-reader or create a second upstream lane');
    assert.strictEqual(engine.timings.demuxFastOpen, false);
    assert.strictEqual(engine.timings.demuxStreamInfoFallback, true);
});

test('a codec mismatch is resolved by same-context stream info and runtime codecpars remain authoritative', async () => {
    const lib = makeLib({ actualVideo: 'hevc' });
    const engine = makeEngine(exactH264MkvProfile(), lib);

    await engine._openInput();

    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_open_input_js').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
    assert.strictEqual(engine._streams[0].codec_id, 27,
        'the catalog profile must never overwrite codec parameters read by libav');
});

test('a stale exact profile cannot fast-open a non-EBML container with matching codecs', async () => {
    const lib = makeLib();
    const engine = makeEngine(exactH264MkvProfile(), lib);
    engine._raCache[0].buf = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);

    await engine._openInput();

    assert.strictEqual(engine.timings.demuxFastOpen, false);
    assert.strictEqual(engine.timings.demuxFastOpenReason, 'source-not-ebml');
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_open_input_js').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
});

test('zero header streams are enriched on the same opened context before failing demux', async () => {
    const lib = makeLib({ emptyBeforeFind: true });
    const engine = makeEngine(exactH264MkvProfile(), lib);

    await engine._openInput();

    assert.strictEqual(engine._streams.length, 2);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_open_input_js').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
});

test('partial or untrusted profiles retain the existing single-open worker helper', async () => {
    for (const profile of [
        null,
        exactH264MkvProfile({ probedAt: '' }),
        exactH264MkvProfile({ probeSource: 'provider' }),
        exactH264MkvProfile({ durationSeconds: 0 }),
        exactH264MkvProfile({ audioTracks: undefined }),
        exactH264MkvProfile({ container: 'mpegts' }),
        exactH264MkvProfile({ videoCodec: 'hevc' }),
    ]) {
        const lib = makeLib();
        const engine = makeEngine(profile, lib);
        await engine._openInput();
        assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_open_input_js').length, 0);
        assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 0);
        assert.deepStrictEqual(
            lib.calls.filter(([name]) => name === 'ff_init_demuxer_file'),
            [['ff_init_demuxer_file', 'input']],
        );
    }
});

test('the exact-profile gate accepts the canonical snake_case aliases', async () => {
    const lib = makeLib();
    const engine = makeEngine({
        video_codec: 'H.264',
        audio_codec: 'AC-3',
        video_width: 1920,
        video_height: 1080,
        audio_channels: 2,
        audio_sample_rate: 48000,
        audio_tracks: [{ index: 1, codec: 'ac3', channels: 2, sample_rate: 48000 }],
        subtitle_tracks: [],
        container: 'matroska,webm',
        duration_seconds: 5400,
        bit_rate: 2_560_000,
        probe_source: 'gateway_probe',
        probed_at: '2026-08-15T00:00:00.000Z',
    }, lib);
    lib.avcodec_get_name = async (codecId) => codecId === 27 ? 'h264' : 'ac3';
    lib.ff_copyout_codecpar = async (codecpar) => codecpar === 201
        ? { codec_id: 27, width: 1920, height: 1080, extradata: AVC_C }
        : { codec_id: 86019, sample_rate: 48000, channels: 2, extradata: null };

    await engine._openInput();

    assert.strictEqual(engine.timings.demuxFastOpen, true);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 0);
});

test('the opened Matroska header duration wins over the external profile duration', async () => {
    const lib = makeLib({ actualAudio: 'ac3', formatDurationUs: 123_000_000 });
    const engine = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }],
        durationSeconds: 5400,
    }), lib);

    await engine._openInput();

    assert.strictEqual(engine.durationSec, 123);
    assert.strictEqual(engine.timings.demuxFastOpen, true);
});

test('a runtime profile mismatch cannot supply a stale fallback duration', async () => {
    const lib = makeLib({ actualVideo: 'hevc', formatDurationUs: 0 });
    const engine = makeEngine(exactH264MkvProfile({ durationSeconds: 5400 }), lib);

    await engine._openInput();

    assert.strictEqual(engine.timings.demuxFastOpen, false);
    assert.strictEqual(engine.durationSec, 0,
        'profile duration is trusted only after the complete runtime header matches');
});

test('a missing selected audio index or runtime codec mismatch uses same-context stream info', async () => {
    const missingLib = makeLib();
    const missing = makeEngine(exactH264MkvProfile({
        audioTracks: [{ index: 7, codec: 'aac', channels: 2 }],
    }), missingLib);
    missing._wantAudioIndex = 7;
    await missing._openInput();
    assert.strictEqual(missingLib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(missingLib.calls.filter(([name]) => name === 'avformat_open_input_js').length, 1);

    const mismatchLib = makeLib();
    const mismatch = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }],
    }), mismatchLib);
    await mismatch._openInput();
    assert.strictEqual(mismatchLib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(mismatchLib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
});

test('every exact audio and subtitle track must match the runtime header map', async () => {
    const missingAudioLib = makeLib();
    const missingAudio = makeEngine(exactH264MkvProfile({
        audioTracks: [
            { index: 1, codec: 'aac', channels: 2 },
            { index: 2, codec: 'ac3', channels: 2 },
        ],
    }), missingAudioLib);
    await missingAudio._openInput();
    assert.strictEqual(missingAudioLib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1,
        'a non-selected track missing from the header invalidates an exact map');

    const extraSubtitleLib = makeLib({ includeSubtitle: true });
    const extraSubtitle = makeEngine(exactH264MkvProfile({ subtitles: [] }), extraSubtitleLib);
    await extraSubtitle._openInput();
    assert.strictEqual(extraSubtitleLib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1,
        'a runtime subtitle omitted by the profile invalidates an exact map');

    const matchingSubtitleLib = makeLib({ actualAudio: 'ac3', includeSubtitle: true });
    const matchingSubtitle = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }],
        subtitles: [{ index: 2, codec: 'subrip' }],
    }), matchingSubtitleLib);
    await matchingSubtitle._openInput();
    assert.strictEqual(matchingSubtitle.timings.demuxFastOpen, true,
        'absolute runtime indices and codecs preserve a complete subtitle map');
});

test('duplicate exact-profile indices cannot hide a different runtime track', async () => {
    const lib = makeLib({ actualAudio: 'ac3', includeSecondAudio: true });
    const engine = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [
            { index: 1, codec: 'ac3', channels: 2 },
            { index: 1, codec: 'ac3', channels: 2 },
        ],
    }), lib);

    await engine._openInput();

    assert.strictEqual(engine.timings.demuxFastOpen, false);
    assert.strictEqual(engine.timings.demuxFastOpenReason, 'audio-track-map-mismatch');
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
});

test('an exact subtitle without a usable runtime timebase falls back on the same context', async () => {
    const lib = makeLib({
        actualAudio: 'ac3',
        includeSubtitle: true,
        subtitleTimeBaseDen: 0,
    });
    const engine = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }],
        subtitles: [{ index: 2, codec: 'subrip' }],
    }), lib);

    await engine._openInput();

    assert.strictEqual(engine.timings.demuxFastOpen, false);
    assert.strictEqual(engine.timings.demuxFastOpenReason, 'subtitle-track-map-mismatch');
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
});

test('HE-AAC, unsafe AAC channels, and unvalidated E-AC-3 remain on stream-info probing', async () => {
    const cases = [
        {
            name: 'HE-AAC',
            profile: exactH264MkvProfile(),
            actualAudio: 'aac',
            codecpar: { codec_id: 86018, sample_rate: 48000, channels: 2, extradata: new Uint8Array([0x2b, 0x92]) },
        },
        {
            name: 'AAC 5.1',
            profile: exactH264MkvProfile({
                audioChannels: 6,
                audioTracks: [{ index: 1, codec: 'aac', channels: 6 }],
            }),
            actualAudio: 'aac',
            codecpar: { codec_id: 86018, sample_rate: 48000, channels: 6, extradata: new Uint8Array([0x11, 0xb0]) },
        },
        {
            name: 'E-AC-3',
            profile: exactH264MkvProfile({
                audioCodec: 'eac3',
                audioChannels: 6,
                audioTracks: [{ index: 1, codec: 'eac3', channels: 6 }],
            }),
            actualAudio: 'eac3',
            codecpar: { codec_id: 86056, sample_rate: 48000, channels: 6, extradata: null },
        },
    ];
    for (const fixture of cases) {
        const lib = makeLib({ actualAudio: fixture.actualAudio });
        const originalCopyout = lib.ff_copyout_codecpar;
        lib.ff_copyout_codecpar = async (codecpar) => codecpar === 202
            ? fixture.codecpar
            : originalCopyout(codecpar);
        const engine = makeEngine(fixture.profile, lib);
        await engine._openInput();
        assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1,
            `${fixture.name} must not use header-only startup`);
    }
});

test('a resolved negative find result preserves a terminal provider 458 and never reopens input', async () => {
    const terminal = new Error('BLOCK_HTTP_458');
    const lib = makeLib({ findReturn: -5 });
    const engine = makeEngine(exactH264MkvProfile({ videoWidth: 1280 }), lib);
    engine._lastReadError = terminal;

    await assert.rejects(() => engine._openInput(), /BLOCK_HTTP_458/);

    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_open_input_js').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
    assert.strictEqual(lib.calls.filter(([name]) => name === 'ff_init_demuxer_file').length, 0);
});

test('AAC-LC, including an implicit SBR sync extension, always stays on stream-info probing', async () => {
    const cases = [
        { name: 'plain AAC-LC', asc: AAC_ASC },
        { name: 'AAC-LC with implicit SBR', asc: new Uint8Array([0x11, 0x90, 0x56, 0xe5, 0x98]) },
    ];
    for (const fixture of cases) {
        const lib = makeLib();
        const originalCopyout = lib.ff_copyout_codecpar;
        lib.ff_copyout_codecpar = async (codecpar) => codecpar === 202
            ? { codec_id: 86018, sample_rate: 48000, channels: 2, extradata: fixture.asc }
            : originalCopyout(codecpar);
        const engine = makeEngine(exactH264MkvProfile(), lib);

        await engine._openInput();

        assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1,
            `${fixture.name} must not enter the v47 fast cohort`);
        assert.strictEqual(engine.timings.demuxFastOpen, false);
    }
});

test('a non-selected AAC track excludes a mixed AC-3/AAC file from the v47 fast cohort', async () => {
    const lib = makeLib({ actualAudio: 'ac3', secondAudio: 'aac', includeSecondAudio: true });
    const engine = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [
            { index: 1, codec: 'ac3', channels: 2 },
            { index: 2, codec: 'aac', channels: 2 },
        ],
    }), lib);
    engine._wantAudioIndex = 1;

    await engine._openInput();

    assert.strictEqual(engine.timings.demuxFastOpen, false);
    assert.strictEqual(engine.timings.demuxFastOpenReason, 'audio-codec-unvalidated');
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1);
});

test('malformed avcC cannot bypass stream-info probing', async () => {
    const lib = makeLib({ actualAudio: 'ac3' });
    const originalCopyout = lib.ff_copyout_codecpar;
    lib.ff_copyout_codecpar = async (codecpar) => {
        const out = await originalCopyout(codecpar);
        if (codecpar === 201) out.extradata = new Uint8Array([1, 100, 0, 40]);
        return out;
    };
    const engine = makeEngine(exactH264MkvProfile({
        audioCodec: 'ac3',
        audioTracks: [{ index: 1, codec: 'ac3', channels: 2 }],
    }), lib);
    await engine._openInput();
    assert.strictEqual(lib.calls.filter(([name]) => name === 'avformat_find_stream_info').length, 1,
        'malformed avcC must fail closed to same-context stream info');
});

test('WatchPage forwards the exact codec profile and cache-busts both changed runtime files', () => {
    const watch = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.html'), 'utf8');
    assert.match(watch, /async playWithEngine\(url, \{[^}]*codecProfile = null/s);
    assert.match(watch, /new window\.NorvaEngine\(this\.video, \{[^}]*codecProfile/s);
    assert.match(watch, /codecProfile: codecProfile \|\| this\._diagCodecProfile \|\| null/);
    assert.match(watch, /await this\.playWithEngine\(url, \{[^}]*codecProfile: options\.codecProfile/s);
    assert.match(app, /\/js\/norvaEngine\.js\?v=51/);
    assert.match(app, /\/js\/pages\/WatchPage\.js\?v=136/);
});
