// Transactional mux writes. The generated libav helper checks each packet write
// inside its worker (one RPC per batch), while NorvaEngine withholds all onwrite
// chunks until that batch succeeds. A partial moof from a rejected batch must
// never reach MediaSource.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadEngineClass() {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
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
    vm.runInContext(src, sandbox, { filename: 'norvaEngine.js' });
    return sandbox.window.NorvaEngine;
}

function makeEngine(NorvaEngine) {
    const reports = [];
    const fatals = [];
    const engine = new NorvaEngine({}, {
        report: (event) => reports.push(event),
        onFatal: (error) => fatals.push(error),
    });
    engine.pkt = 101;
    engine.oc = 202;
    engine.destroyed = false;
    engine._stopRequested = false;
    engine._fatalSignaled = false;
    engine._muxGeneration = 7;
    engine._muxWriteStage = null;
    return { engine, reports, fatals };
}

test('every generated wasm helper checks packet-write errors inside the worker', () => {
    const dir = path.join(ROOT, 'public', 'webengine', 'vendor', 'libav');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.wasm.mjs'));
    assert.ok(files.length >= 2, 'expected the vendored norva and webcodecs wasm glue');
    for (const name of files) {
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        assert.ok(src.includes('var __norvaMuxWriteRet=step(oc,pkt);'),
            `${name} must retain the packet write result`);
        assert.ok(src.includes('throw new Error("MUX_PACKET_WRITE_FAILED:"'),
            `${name} must surface a typed worker error`);
        assert.ok(!src.includes('step(oc,pkt);av_packet_unref(pkt)'),
            `${name} must not contain the unchecked generated helper`);
    }

    const patcher = fs.readFileSync(path.join(ROOT, 'scripts', 'patch-libav-logs.js'), 'utf8');
    assert.ok(patcher.includes("const MUX_MARKER = 'MUX_PACKET_WRITE_FAILED:'"),
        'the build-time patch must be independently idempotent');
    assert.ok(patcher.includes('src.includes(MUX_MARKER)'),
        'the build-time patch must detect an already-patched helper');
});

test('engine cache-busts the loader, worker glue, and wasm binary together', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    assert.ok(src.includes("libav-norva.mjs?v=45"),
        'dynamic loader import must be revisioned');
    assert.ok(src.includes("libav-6.8.8.0-norva.wasm.mjs?v=45"),
        'worker glue import must be revisioned');
    assert.ok(src.includes("libav-6.8.8.0-norva.wasm.wasm?v=45"),
        'wasm binary fetch must be revisioned');
    assert.ok(src.includes('toImport: LIBAV_RUNTIME'));
    assert.ok(src.includes('wasmurl: LIBAV_WASM'));
});

test('engine failure telemetry preserves bounded timestamp and last-append evidence', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');
    assert.ok(src.includes('videoDtsRepairs: snap.videoDtsRepairs'));
    assert.ok(src.includes('firstVideoTimestampError: snap.firstVideoTimestampError'));
    assert.ok(src.includes('videoDurationCorrections: snap.videoDurationCorrections'));
    assert.ok(src.includes('firstVideoDurationError: snap.firstVideoDurationError'));
    assert.ok(src.includes('snap.recentAppends[snap.recentAppends.length - 1]'));
    assert.ok(src.includes("a.boxes.slice(0, 160)"),
        'only a bounded last-append box summary may be persisted');
    const compact = src.slice(src.indexOf('engineSnapshot: snap ? {'), src.indexOf('} : null', src.indexOf('engineSnapshot: snap ? {')));
    assert.ok(!compact.includes('recentAppends: snap.recentAppends'),
        'the growing append ring must never be persisted wholesale');
});

test('video DTS reconstruction does not accumulate rounded 23.976 fps packet durations', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { time_base_num: 1, time_base_den: 1000 };

    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    let lastDts = null;

    // Kartavya's millisecond Matroska time base reports duration=43 while the
    // real 24000/1001 cadence advances PTS by about 41.7 ms. The old cumulative
    // duration grid exhausted its 16-frame cushion at frame 534 (~22.3 s), then
    // sent pts<dts to movenc and received EINVAL.
    for (let i = 0; i < 2000; i++) {
        // Model a small B-frame reorder too: decode order 0,2,1,3,5,4,...
        const presentationIndex = Math.floor(i / 3) * 3 + [0, 2, 1][i % 3];
        const pts = Math.round(presentationIndex * 1001 / 24);
        const [ptsLo, ptsHi] = split64(pts);
        const packet = { pts: ptsLo, ptshi: ptsHi, duration: 43, flags: i === 0 ? 1 : 0 };
        engine._setVideoDts(packet);
        const dts = join64(packet.dts, packet.dtshi);

        assert.ok(dts <= pts, `frame ${i}: pts ${pts} must not precede dts ${dts}`);
        if (lastDts !== null) assert.ok(dts > lastDts, `frame ${i}: dts must increase strictly`);
        lastDts = dts;
    }

    assert.strictEqual(engine._diag.videoDtsRepairs || 0, 0,
        'normal fractional cadence must not need one-tick duplicate repair');
});

test('a stable source DTS timeline is preserved without the synthetic 16-frame offset', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { time_base_num: 1, time_base_den: 1000 };

    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    const expectedDts = [];
    const emitted = [];
    for (let i = 0; i < 80; i++) {
        const ts = 83 + Math.round(i * 1001 / 24);
        expectedDts.push(ts);
        const [lo, hi] = split64(ts);
        const packet = { id: i, pts: lo, ptshi: hi, dts: lo, dtshi: hi, duration: 43, flags: i === 0 ? 1 : 0 };
        emitted.push(...engine._ingestVideoPacket(packet));
    }
    emitted.push(...engine._flushVideoPacketsAtEof());

    assert.strictEqual(engine._videoDtsMode, 'source');
    assert.strictEqual(engine._diag.videoDtsMode, 'source');
    assert.strictEqual(engine._diag.sourceVideoDtsRejectedReason || null, null);
    assert.strictEqual(engine._diag.sourceVideoDtsPackets, expectedDts.length);
    assert.strictEqual(emitted.length, expectedDts.length);
    assert.deepStrictEqual(emitted.map((packet) => join64(packet.dts, packet.dtshi)), expectedDts);
    assert.strictEqual(join64(emitted[0].dts, emitted[0].dtshi), 83,
        'the first exact source DTS must not become 83 - (16 * 43)');
});

test('PTS copied into a reordered DTS field is rejected before any packet reaches the muxer', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { time_base_num: 1, time_base_den: 1000 };

    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    // This is the shape exposed by the vendored demuxer for the HEVC fixture:
    // DTS is merely copied from reordered PTS (0, 167, 83, 42, ...).
    const ptsValues = [0, 167, 83, 42, 125, 333, 250, 208, 292, 500, 417, 375, 458, 667, 583, 542, 625];
    const emitted = [];
    for (let i = 0; i < ptsValues.length; i++) {
        const [lo, hi] = split64(ptsValues[i]);
        const ready = engine._ingestVideoPacket({
            id: i, pts: lo, ptshi: hi, dts: lo, dtshi: hi, duration: 41, flags: i === 0 ? 1 : 0,
        });
        if (i < 2) assert.strictEqual(ready.length, 0, 'probe packets must not leak before the verdict');
        emitted.push(...ready);
    }
    emitted.push(...engine._flushVideoPacketsAtEof());

    assert.strictEqual(engine._videoDtsMode, 'reconstructed');
    assert.strictEqual(engine._diag.sourceVideoDtsRejectedReason, 'non-monotonic');
    assert.strictEqual(engine._diag.sourceVideoDtsPackets || 0, 0);
    assert.strictEqual(emitted.length, ptsValues.length);
    let lastDts = null;
    for (const packet of emitted) {
        const dts = join64(packet.dts, packet.dtshi);
        const pts = join64(packet.pts, packet.ptshi);
        if (lastDts !== null) assert.ok(dts > lastDts);
        assert.ok(dts <= pts);
        lastDts = dts;
    }
});

test('AV_NOPTS_VALUE with monotonic PTS uses DTS=PTS while a short valid stream keeps source DTS at EOF', () => {
    const NorvaEngine = loadEngineClass();
    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);

    {
        const { engine } = makeEngine(NorvaEngine);
        engine.vS = { time_base_num: 1, time_base_den: 1000 };
        const ptsValues = Array.from({ length: 20 }, (_, i) => Math.round(i * 1001 / 24));
        const emitted = [];
        for (let i = 0; i < ptsValues.length; i++) {
            const [pts, ptshi] = split64(ptsValues[i]);
            emitted.push(...engine._ingestVideoPacket({
                id: i, pts, ptshi, dts: 0, dtshi: -2147483648,
                duration: 43, flags: i === 0 ? 1 : 0,
            }));
        }
        emitted.push(...engine._flushVideoPacketsAtEof());
        assert.strictEqual(engine._videoDtsMode, 'pts-monotonic');
        assert.strictEqual(engine._diag.sourceVideoDtsRejectedReason, 'missing');
        assert.strictEqual(engine._diag.monotonicPtsRejectedReason || null, null);
        assert.deepStrictEqual(emitted.map((packet) => join64(packet.dts, packet.dtshi)), ptsValues);
        assert.strictEqual(join64(emitted[0].dts, emitted[0].dtshi), 0,
            'missing DTS on a monotonic stream must not invent a negative reorder offset');
    }

    {
        const { engine } = makeEngine(NorvaEngine);
        engine.vS = { time_base_num: 1, time_base_den: 1000 };
        const sourceDts = [10_000, 10_042, 10_083];
        const emitted = [];
        for (let i = 0; i < sourceDts.length; i++) {
            const [lo, hi] = split64(sourceDts[i]);
            emitted.push(...engine._ingestVideoPacket({
                id: i, pts: lo, ptshi: hi, dts: lo, dtshi: hi, duration: 43, flags: i === 0 ? 1 : 0,
            }));
        }
        assert.strictEqual(emitted.length, 0, 'a short stream remains in the bounded probe until EOF');
        emitted.push(...engine._flushVideoPacketsAtEof());
        assert.strictEqual(engine._videoDtsMode, 'source');
        assert.deepStrictEqual(emitted.map((packet) => join64(packet.dts, packet.dtshi)), sourceDts);
    }
});

test('short AV_NOPTS streams choose monotonic PTS or reconstruction correctly at EOF', () => {
    const NorvaEngine = loadEngineClass();
    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);

    {
        const { engine } = makeEngine(NorvaEngine);
        engine.vS = { time_base_num: 1, time_base_den: 1000 };
        const ptsValues = [10_000, 10_042, 10_083];
        for (let i = 0; i < ptsValues.length; i++) {
            const [pts, ptshi] = split64(ptsValues[i]);
            assert.strictEqual(engine._ingestVideoPacket({
                id: i, pts, ptshi, dts: 0, dtshi: -2147483648,
                duration: 43, flags: i === 0 ? 1 : 0,
            }).length, 0);
        }
        const emitted = engine._flushVideoPacketsAtEof();
        assert.strictEqual(engine._videoDtsMode, 'pts-monotonic');
        assert.deepStrictEqual(Array.from(emitted, (packet) => join64(packet.dts, packet.dtshi)), ptsValues);
    }

    {
        const { engine } = makeEngine(NorvaEngine);
        engine.vS = { time_base_num: 1, time_base_den: 1000 };
        const ptsValues = [0, 167, 83, 42, 125];
        const emitted = [];
        for (let i = 0; i < ptsValues.length; i++) {
            const [pts, ptshi] = split64(ptsValues[i]);
            emitted.push(...engine._ingestVideoPacket({
                id: i, pts, ptshi, dts: 0, dtshi: -2147483648,
                duration: 42, flags: i === 0 ? 1 : 0,
            }));
        }
        emitted.push(...engine._flushVideoPacketsAtEof());
        assert.strictEqual(engine._videoDtsMode, 'reconstructed');
        assert.strictEqual(engine._diag.sourceVideoDtsRejectedReason, 'missing');
        assert.strictEqual(engine._diag.monotonicPtsRejectedReason, 'non-monotonic');
        let lastDts = null;
        for (const packet of emitted) {
            const dts = join64(packet.dts, packet.dtshi);
            const pts = join64(packet.pts, packet.ptshi);
            assert.ok(dts <= pts);
            if (lastDts !== null) assert.ok(dts > lastDts);
            lastDts = dts;
        }
    }
});

test('audio cannot reach the muxer before the source-DTS probe resolves', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { index: 0, time_base_num: 1, time_base_den: 1000 };

    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const writeList = [];
    engine._stageAudioForVideoDtsProbe({ id: 'audio-old-1' }, writeList);
    engine._stageAudioForVideoDtsProbe({ id: 'audio-old-2' }, writeList);
    assert.deepStrictEqual(writeList, [], 'no audio-only mux write is legal during the video probe');
    assert.strictEqual(engine._videoDtsProbeAudio.length, 2);

    let readyVideo = [];
    for (let i = 0; i < 16; i++) {
        const ts = 1_000 + i * 42;
        const [lo, hi] = split64(ts);
        readyVideo.push(...engine._ingestVideoPacket({
            id: `video-${i}`, pts: lo, ptshi: hi, dts: lo, dtshi: hi, duration: 42, flags: i === 0 ? 1 : 0,
        }));
    }
    assert.strictEqual(engine._videoDtsMode, 'source');
    assert.ok(readyVideo.length > 0);
    writeList.push(...readyVideo);
    engine._releaseVideoDtsProbeAudio(writeList);
    engine._stageAudioForVideoDtsProbe({ id: 'audio-new' }, writeList);

    const ids = writeList.map((packet) => packet.id);
    assert.ok(ids.indexOf('audio-old-1') > ids.lastIndexOf('video-14'),
        'deferred audio is released only after probe video becomes mux-ready');
    assert.deepStrictEqual(ids.slice(-3), ['audio-old-1', 'audio-old-2', 'audio-new'],
        'older deferred audio must precede newer audio from the resolving batch');
    assert.strictEqual(engine._videoDtsProbeAudio.length, 0);
    assert.strictEqual(engine._diag.videoDtsProbeAudioDeferred, 2);
    assert.strictEqual(engine._diag.videoDtsProbeAudioReleased, 2);
});

test('transcoded audio uses one continuous 48 kHz sample clock', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.aS = { time_base_num: 1, time_base_den: 1000 };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };

    // Real filter output observed on the Matroska AAC-transcode fixture. The
    // rounded source clock advances 1013/1014/1061 ticks even though every frame
    // contains exactly 1024 samples.
    const rawPts = [-1104, -80, 933, 1947, 2961, 4022, 5035, 6049, 7062, 8123, 9137];
    const frames = rawPts.map((pts) => {
        const [lo, hi] = split64(pts);
        return {
            pts: lo, ptshi: hi, time_base_num: 1, time_base_den: 48000,
            nb_samples: 1024,
        };
    });
    engine._normalizeFilteredAudioFrames(frames);

    const expected = rawPts.map((_, i) => -1104 + i * 1024);
    assert.deepStrictEqual(frames.map((frame) => join64(frame.pts, frame.ptshi)), expected);
    assert.ok(frames.every((frame) => frame.time_base_num === 1 && frame.time_base_den === 48000));
    assert.strictEqual(engine._audioNextPts48k, -1104 + frames.length * 1024);
    assert.strictEqual(engine._diag.audioClockAnchorSource, 'filtered');
    assert.strictEqual(engine._diag.audioClockCorrections, 9);
    assert.deepStrictEqual({ ...engine._diag.firstAudioClockCorrection }, {
        rawPts48k: 933, expectedPts48k: 944, delta48k: -11, samples: 1024,
    });

    const { engine: millisEngine } = makeEngine(NorvaEngine);
    millisEngine.aS = { time_base_num: 1, time_base_den: 1000 };
    const [msLo, msHi] = split64(83);
    const millisecondFrame = {
        pts: msLo, ptshi: msHi, time_base_num: 1, time_base_den: 1000,
        nb_samples: 1024,
    };
    millisEngine._normalizeFilteredAudioFrames([millisecondFrame]);
    assert.strictEqual(join64(millisecondFrame.pts, millisecondFrame.ptshi), 3984,
        '83 ms must be rescaled exactly onto the 48 kHz encoder clock');
    assert.strictEqual(millisEngine._audioNextPts48k, 5008);
});

test('audio timeline falls back to decoded PTS and fails typed when every PTS is unavailable', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.aS = { time_base_num: 1, time_base_den: 1000 };
    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    const [decodedLo, decodedHi] = split64(1000);
    engine._captureDecodedAudioAnchor([{
        pts: decodedLo, ptshi: decodedHi, time_base_num: 1, time_base_den: 1000,
        nb_samples: 1024,
    }]);
    const filtered = [{
        pts: 0, ptshi: -2147483648, time_base_num: 1, time_base_den: 48000,
        nb_samples: 1024,
    }];
    engine._normalizeFilteredAudioFrames(filtered);
    assert.strictEqual(join64(filtered[0].pts, filtered[0].ptshi), 48000);
    assert.strictEqual(engine._diag.audioClockAnchorSource, 'decoded');

    const { engine: noPtsEngine } = makeEngine(NorvaEngine);
    noPtsEngine.aS = { time_base_num: 1, time_base_den: 1000 };
    assert.throws(() => noPtsEngine._normalizeFilteredAudioFrames([{
        pts: 0, ptshi: -2147483648, time_base_num: 1, time_base_den: 48000,
        nb_samples: 1024,
    }]), (error) => error && error.code === 'AUDIO_PTS_UNAVAILABLE');
    assert.strictEqual(noPtsEngine._diag.audioTimelineFailures, 1);
    assert.strictEqual(noPtsEngine._diag.firstAudioTimelineFailure.code, 'AUDIO_PTS_UNAVAILABLE');
});

test('a typed audio timeline failure reports and enters fatal recovery only once', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const failure = new Error('AUDIO_PTS_UNAVAILABLE:no timestamp');
    failure.code = 'AUDIO_PTS_UNAVAILABLE';
    engine._pump = async () => { throw failure; };

    engine._startPump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(reports.filter((event) => event.stage === 'pump').length, 1);
    assert.strictEqual(fatals.length, 1);
    assert.strictEqual(fatals[0], failure);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.strictEqual(engine._stopRequested, true);

    engine._startPump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(reports.filter((event) => event.stage === 'pump').length, 1,
        'a second rejected pump must not duplicate the persisted report');
    assert.strictEqual(fatals.length, 1, 'onFatal must be signalled once per mux generation');
});

test('deferred audio drops only samples wholly before the retained video keyframe', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { index: 0, time_base_num: 1, time_base_den: 1000 };
    engine.vBase = 1000;
    engine.copyAudio = false;
    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const audio = (id, pts, duration) => {
        const [lo, hi] = split64(pts);
        return {
            id, pts: lo, ptshi: hi, duration, durationhi: 0,
            time_base_num: 1, time_base_den: 48000,
        };
    };

    const writeList = [];
    engine._stageAudioForVideoDtsProbe(audio('ends-at-base', 47000, 1000), writeList);
    engine._stageAudioForVideoDtsProbe(audio('overlaps-base', 47500, 1024), writeList);
    engine._stageAudioForVideoDtsProbe(audio('after-base', 48000, 1024), writeList);
    assert.deepStrictEqual(writeList, []);
    assert.deepStrictEqual(Array.from(engine._videoDtsProbeAudio, (packet) => packet.id),
        ['overlaps-base', 'after-base'],
        'a packet overlapping vBase must be retained; only end<=vBase is dropped');
    assert.strictEqual(engine._diag.droppedProbeAudioBeforeVideoBase, 1);

    engine._videoDtsMode = 'pts-monotonic';
    engine._releaseVideoDtsProbeAudio(writeList);
    assert.deepStrictEqual(writeList.map((packet) => packet.id), ['overlaps-base', 'after-base']);
    assert.strictEqual(engine._diag.videoDtsProbeAudioReleased, 2);
});

test('EOF writes probed video before deferred audio and lifecycle discard drops both', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { index: 0, time_base_num: 1, time_base_den: 1000 };
    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };

    for (let i = 0; i < 3; i++) {
        const ts = 5_000 + i * 42;
        const [lo, hi] = split64(ts);
        assert.strictEqual(engine._ingestVideoPacket({
            id: `video-${i}`, pts: lo, ptshi: hi, dts: lo, dtshi: hi, duration: 42, flags: i === 0 ? 1 : 0,
        }).length, 0);
    }
    engine._stageAudioForVideoDtsProbe({ id: 'audio-eof' }, []);
    const eofPackets = engine._flushVideoPacketsAtEof();
    engine._releaseVideoDtsProbeAudio(eofPackets, true);
    assert.deepStrictEqual(Array.from(eofPackets, (packet) => packet.id),
        ['video-0', 'video-1', 'video-2', 'audio-eof']);

    engine._videoDtsProbe.push({ id: 'stale-video' });
    engine._videoDtsProbeAudio.push({ id: 'stale-audio' });
    engine._sourceDtsProbeViable = false;
    engine._sourceDtsProbeRejectedReason = 'missing';
    engine._monotonicPtsProbeViable = false;
    engine._monotonicPtsProbeRejectedReason = 'non-monotonic';
    engine._audioNextPts48k = 1234;
    engine._audioDecodedAnchor48k = 1200;
    engine._discardPendingVideoPacket();
    assert.strictEqual(engine._videoDtsProbe.length, 0);
    assert.strictEqual(engine._videoDtsProbeAudio.length, 0);
    assert.strictEqual(engine._videoDtsMode, null);
    assert.strictEqual(engine._sourceDtsProbeViable, true);
    assert.strictEqual(engine._sourceDtsProbeRejectedReason, null);
    assert.strictEqual(engine._monotonicPtsProbeViable, true);
    assert.strictEqual(engine._monotonicPtsProbeRejectedReason, null);
    assert.strictEqual(engine._audioNextPts48k, null);
    assert.strictEqual(engine._audioDecodedAnchor48k, null);
});

test('video packet durations exactly bridge reconstructed DTS across every fragment', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { time_base_num: 1, time_base_den: 1000 };

    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    const muxPackets = [];

    // Use enough frames to cross the production failure window (>200 s), with
    // keyframes every 48 frames so each one starts a fresh fMP4 fragment.
    for (let i = 0; i < 6000; i++) {
        const presentationIndex = Math.floor(i / 3) * 3 + [0, 2, 1][i % 3];
        const pts = 53_416 + Math.round(presentationIndex * 1001 / 24);
        const [ptsLo, ptsHi] = split64(pts);
        const packet = {
            pts: ptsLo,
            ptshi: ptsHi,
            duration: 43,
            flags: i % 48 === 0 ? 1 : 0,
        };
        const ready = engine._prepareVideoPacket(packet);
        if (ready) muxPackets.push(ready);
    }

    assert.ok(muxPackets.length > 5900);
    let startDts = null;
    let trackDuration = 0;
    let fragments = 0;
    for (let i = 0; i < muxPackets.length; i++) {
        const packet = muxPackets[i];
        const dts = join64(packet.dts, packet.dtshi);
        if (startDts === null) startDts = dts;
        if ((packet.flags & 1) && i > 0) {
            fragments += 1;
            // movenc performs exactly this adjustment for the first packet in a
            // new fragment. A mismatch here becomes a delayed MSE append failure.
            assert.strictEqual(startDts + trackDuration, dts,
                `fragment ${fragments}: duration sum must land on its first DTS`);
        }
        assert.ok(packet.duration > 0);
        assert.strictEqual(packet.durationhi, 0);
        if (i + 1 < muxPackets.length) {
            const nextDts = join64(muxPackets[i + 1].dts, muxPackets[i + 1].dtshi);
            assert.strictEqual(packet.duration, nextDts - dts,
                `packet ${i}: duration must equal the next DTS delta`);
        }
        trackDuration = dts - startDts + packet.duration;
    }

    assert.ok(fragments > 100, 'the regression must cover many fMP4 fragments');
    assert.ok(engine._diag.videoDurationCorrections > 1000,
        'rounded source durations should be replaced by exact 41/42 ms deltas');
    assert.strictEqual(engine._diag.firstVideoDurationError || null, null);
});

test('video lookahead survives batch partitions and EOF emits every packet exactly once', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    engine.vS = { time_base_num: 1, time_base_den: 1000 };

    const split64 = (value) => {
        const hi = Math.floor(value / 4294967296);
        return [(value - hi * 4294967296) >>> 0, hi];
    };
    const join64 = (lo, hi) => hi * 4294967296 + (lo >>> 0);
    const ptsValues = [53_416, 53_458, 53_499, 53_541, 53_583, 53_625, 53_666];
    const packets = ptsValues.map((pts, id) => {
        const [ptsLo, ptsHi] = split64(pts);
        return { id, pts: ptsLo, ptshi: ptsHi, duration: 43, flags: id === 0 ? 1 : 0 };
    });
    // Model independent ff_read_frame_multi calls, including empty and
    // single-video batches. The lookahead must remain engine state, not local
    // state tied to one batch.
    const batches = [[packets[0]], [], [packets[1], packets[2]], [packets[3]],
        [packets[4], packets[5]], [packets[6]]];
    const emitted = [];
    for (const batch of batches) {
        for (const packet of batch) {
            const ready = engine._prepareVideoPacket(packet);
            if (ready) emitted.push(ready);
        }
    }
    const tail = engine._flushPendingVideoPacket();
    if (tail) emitted.push(tail);

    assert.deepStrictEqual(emitted.map((packet) => packet.id), packets.map((packet) => packet.id));
    assert.strictEqual(engine._pendingVideoPacket, null);
    for (let i = 0; i < emitted.length; i++) {
        assert.ok(emitted[i].duration > 0, `packet ${i}: duration must be positive`);
        assert.strictEqual(emitted[i].durationhi, 0);
        if (i + 1 < emitted.length) {
            const dts = join64(emitted[i].dts, emitted[i].dtshi);
            const nextDts = join64(emitted[i + 1].dts, emitted[i + 1].dtshi);
            assert.strictEqual(emitted[i].duration, nextDts - dts);
        }
    }
});

test('seek, mux reinitialisation, and destroy discard lookahead before teardown work', async () => {
    const NorvaEngine = loadEngineClass();

    {
        const { engine } = makeEngine(NorvaEngine);
        const retained = { id: 'seek-old-generation' };
        engine._pendingVideoPacket = retained;
        engine._lastExactVideoDuration = 42;
        let freed = false;
        engine.lib = {
            ff_free_muxer: async () => {
                assert.strictEqual(engine._pendingVideoPacket, null,
                    'seek must discard lookahead before freeing the old muxer');
                assert.strictEqual(engine._lastExactVideoDuration, null);
                freed = true;
            },
        };
        await engine._resetForSeek();
        assert.strictEqual(freed, true);
    }

    {
        const { engine } = makeEngine(NorvaEngine);
        engine.vS = null;
        engine.aS = null;
        engine._pendingVideoPacket = { id: 'init-old-generation' };
        engine._lastExactVideoDuration = 41;
        let unlinked = false;
        engine.lib = {
            unlink: async () => {
                assert.strictEqual(engine._pendingVideoPacket, null,
                    'mux init must discard lookahead before touching the output device');
                assert.strictEqual(engine._lastExactVideoDuration, null);
                unlinked = true;
            },
            mkstreamwriterdev: async () => {},
            ff_init_muxer: async () => [303, null, null, []],
            av_opt_set: async () => {},
            avformat_write_header: async () => {},
            av_packet_alloc: async () => 404,
        };
        await engine._initMuxer();
        assert.strictEqual(unlinked, true);
    }

    {
        const { engine } = makeEngine(NorvaEngine);
        engine._pendingVideoPacket = { id: 'destroy-old-generation' };
        engine._lastExactVideoDuration = 42;
        let terminated = false;
        engine.lib = {
            terminate: () => {
                assert.strictEqual(engine._pendingVideoPacket, null,
                    'destroy must discard lookahead before terminating the worker');
                assert.strictEqual(engine._lastExactVideoDuration, null);
                terminated = true;
            },
        };
        engine.destroy();
        assert.strictEqual(terminated, true);
    }
});

test('a successful batch uses one worker RPC and commits staged bytes only afterwards', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const events = [];
    const committed = [];
    let batchCalls = 0;
    engine._commitMuxWrite = (name, pos, chunk) => {
        events.push('commit');
        committed.push({ name, pos, bytes: Array.from(chunk) });
    };
    engine.lib = {
        ff_write_multi: async (oc, pkt, packets) => {
            batchCalls += 1;
            events.push('worker');
            assert.strictEqual(oc, 202);
            assert.strictEqual(pkt, 101);
            assert.strictEqual(packets.length, 2);
            assert.deepStrictEqual(committed, [], 'bytes must remain private while the worker call is pending');
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 0,
                chunk: new Uint8Array([0, 0, 0, 8, 109, 111, 111, 102]),
            });
        },
    };

    const packets = [
        { data: new Uint8Array([1]), stream_index: 0, time_base_num: 1, time_base_den: 1000 },
        { data: new Uint8Array([2]), stream_index: 1, time_base_num: 1, time_base_den: 48000 },
    ];
    assert.strictEqual(await engine._writePacketsChecked(packets), true);
    assert.strictEqual(batchCalls, 1, 'the whole batch must stay one worker RPC');
    assert.deepStrictEqual(events, ['worker', 'commit']);
    assert.strictEqual(committed.length, 1);
    assert.deepStrictEqual(reports, []);
    assert.deepStrictEqual(fatals, []);
});

test('a rejected batch drops every partial chunk and signals fatal recovery', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const committed = [];
    engine._commitMuxWrite = (...args) => committed.push(args);
    engine.lib = {
        ff_write_multi: async () => {
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 123,
                chunk: new Uint8Array([0, 0, 0, 16, 109, 111, 111, 102]),
            });
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 131,
                chunk: new Uint8Array([1, 2, 3, 4]),
            });
            throw new Error('MUX_PACKET_WRITE_FAILED:-29:Illegal seek');
        },
    };

    const ok = await engine._writePacketsChecked([
        { data: new Uint8Array([7]), stream_index: 1 },
    ]);
    await Promise.resolve();

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(committed, [], 'partial moof bytes must never be committed to appendBuffer');
    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.strictEqual(engine._muxWriteStage, null);
    assert.strictEqual(engine._diag.muxPacketWriteErrors, 1);
    assert.strictEqual(engine._diag.muxRejectedBytes, 12);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(engine._diag.firstMuxPacketWriteError)),
        {
            ret: -29,
            batchPackets: 1,
            streamIndexes: [1],
            stagedChunks: 2,
            stagedBytes: 12,
            stagedBoxes: ['moof(16)', ''],
            detail: 'Illegal seek',
        });
    assert.strictEqual(reports.length, 1);
    assert.strictEqual(reports[0].stage, 'mux:packet-write');
    assert.match(reports[0].message, /MUX_PACKET_WRITE_FAILED:-29:Illegal seek/);
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /MUX_PACKET_WRITE_FAILED:-29/);
});

test('a batch resolved after a seek generation change is dropped without replacing the new mux', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const committed = [];
    engine._commitMuxWrite = (...args) => committed.push(args);
    engine.lib = {
        ff_write_multi: async () => {
            engine._muxWriteStage.writes.push({
                name: 'output',
                pos: 0,
                chunk: new Uint8Array([0, 0, 0, 8, 109, 111, 111, 102]),
            });
            engine._muxGeneration += 1; // a newer seek/mux won while this RPC was pending
        },
    };

    const ok = await engine._writePacketsChecked([
        { data: new Uint8Array([1]), stream_index: 0 },
    ]);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(committed, []);
    assert.strictEqual(engine._diag.staleMuxBytesDropped, 8);
    assert.strictEqual(engine._diag.firstStaleMuxDrop.reason, 'stale-success');
    assert.deepStrictEqual(reports, [], 'an intentionally obsolete mux must not trigger recovery');
    assert.deepStrictEqual(fatals, []);
});

test('the cumulative MP4 parser accepts fragmented boxes split across AVIO writes', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);
    const box = (type, bodyBytes) => {
        const out = new Uint8Array(8 + bodyBytes);
        new DataView(out.buffer).setUint32(0, out.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        return out;
    };
    const stream = Buffer.concat([
        Buffer.from(box('ftyp', 20)),
        Buffer.from(box('moov', 31)),
        Buffer.from(box('moof', 17)),
        Buffer.from(box('mdat', 4096)),
    ]);

    for (const [start, end] of [[0, 5], [5, 37], [37, 111], [111, stream.length]]) {
        engine._diagTrackBoxes(new Uint8Array(stream.subarray(start, end)));
    }

    assert.strictEqual(engine._diag.boxBad, null);
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(engine._diag.boxSeq)),
        ['ftyp(28)', 'moov(39)', 'moof(25)', 'mdat(4104)']);
});

test('an ISO-BMFF size-zero box consumes later AVIO blocks through EOF', () => {
    const NorvaEngine = loadEngineClass();
    const { engine } = makeEngine(NorvaEngine);

    engine._diagTrackBoxes(new Uint8Array([
        0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74, 1, 2, 3,
    ]));
    engine._diagTrackBoxes(new Uint8Array([
        0x38, 0, 0, 0, 0x67, 0x61, 0x72, 0x62,
    ]));

    assert.strictEqual(engine._diag.boxBad, null);
    assert.strictEqual(engine._diag.boxOpenEnded, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(engine._diag.boxSeq)), ['mdat(EOF)']);
});

test('a structurally impossible MP4 boundary is rejected before MediaSource', async () => {
    const NorvaEngine = loadEngineClass();
    const { engine, reports, fatals } = makeEngine(NorvaEngine);
    const badChunk = new Uint8Array([0x38, 0, 0, 0, 0x67, 0x61, 0x72, 0x62]);

    engine._diagTrackBoxes(badChunk);
    assert.match(engine._diag.boxBad, /type="garb"/);
    assert.match(engine._diag.boxBad, /size=939524096/);
    assert.strictEqual(engine._rejectInvalidMuxStructure(badChunk), true);
    await Promise.resolve();

    assert.strictEqual(engine._stopRequested, true);
    assert.strictEqual(engine._fatalSignaled, true);
    assert.strictEqual(engine._diag.muxStructureErrors, 1);
    assert.strictEqual(engine._diag.muxRejectedBytes, badChunk.length);
    assert.strictEqual(engine._diag.firstMuxStructureError.rejectedBytes, badChunk.length);
    assert.strictEqual(reports[0].stage, 'mux:structure');
    assert.match(reports[0].message, /MUX_STRUCTURE_INVALID/);
    assert.strictEqual(fatals.length, 1);
    assert.match(fatals[0].message, /MUX_STRUCTURE_INVALID/);

    const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'norvaEngine.js'), 'utf8');
    const guard = source.slice(
        source.indexOf('this._diagTrackBoxes(chunk);'),
        source.indexOf('this.queue.push(chunk); this._drain();'),
    );
    assert.ok(guard.includes('this._rejectInvalidMuxStructure(chunk)'),
        'the structural guard must run before the chunk is queued for MediaSource');
});
