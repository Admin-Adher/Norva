const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'public', 'webengine', 'vendor', 'libav');
const WRAPPER = path.join(VENDOR, 'libav-norva.mjs');
const WASM = path.join(VENDOR, 'libav-6.8.8.0-norva.wasm.wasm');
const FIXTURE = path.join(ROOT, 'public', 'webengine', 'media', 's_h264_aac.mkv');

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

function join64(lo, hi) {
    return hi * 4294967296 + (lo >>> 0);
}

function split64(value) {
    const hi = Math.floor(value / 4294967296);
    return [(value - hi * 4294967296) >>> 0, hi];
}

function shiftTimestamp(packet, field, highField, delta) {
    if (!Number.isInteger(packet[field]) || !Number.isInteger(packet[highField])) return;
    if ((packet[field] >>> 0) === 0 && packet[highField] === -2147483648) return;
    const [lo, hi] = split64(join64(packet[field], packet[highField]) + delta);
    packet[field] = lo;
    packet[highField] = hi;
}

test('full-scan MKV resume flushes moov and media before trailer with a long first GOP', {
    timeout: 20_000,
}, async (t) => {
    const { LibAV } = await import(pathToFileURL(WRAPPER).href);
    const lib = await LibAV({
        base: pathToFileURL(VENDOR).href,
        wasmurl: pathToFileURL(WASM).href,
    });
    t.after(() => { try { lib.terminate?.(); } catch (_) {} });
    await lib.av_log_set_level(lib.AV_LOG_ERROR);
    await lib.writeFile('resume-source.mkv', new Uint8Array(fs.readFileSync(FIXTURE)));
    const [fmtCtx, streams] = await lib.ff_init_demuxer_file('resume-source.mkv');
    const videoStream = streams.find((stream) => stream.codec_type === 0);
    const audioStream = streams.find((stream) => stream.codec_type === 1);
    assert.ok(videoStream && audioStream, 'fixture must retain one video and one audio stream');
    assert.strictEqual(await lib.avcodec_get_name(videoStream.codec_id), 'h264');
    assert.strictEqual(await lib.avcodec_get_name(audioStream.codec_id), 'aac');

    const NorvaEngine = loadEngineClass();
    const engine = new NorvaEngine({ currentTime: 63 }, {});
    engine.lib = lib;
    engine.vS = videoStream;
    engine.aS = audioStream;
    engine.vName = 'h264';
    engine.aName = 'aac';
    engine.copyAudio = true;
    engine.V_IDX = 0;
    engine.A_IDX = 1;
    engine.mime = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';
    engine.timings = { demuxFastOpen: false };
    engine._raCache = [{
        start: 0,
        end: 4,
        buf: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
    }];
    engine._drain = () => {};
    await engine._initMuxer();
    assert.strictEqual(engine._pumpReadBatchBytes, 256 * 1024,
        'the real pump must cap transactional worker batches for bounded H264 MKV');
    assert.strictEqual(engine._boundedPumpBatchGeneration, engine._muxGeneration);

    engine._tsAnchor = 63;
    engine._firstVpktPending = true;
    const sourcePacket = await lib.av_packet_alloc();
    const videoTargetTicks = Math.round(62.563 * videoStream.time_base_den / videoStream.time_base_num);
    const audioTargetTicks = Math.round(62.544 * audioStream.time_base_den / audioStream.time_base_num);
    let firstVideoSourcePts = null;
    let firstAudioSourcePts = null;
    let latestVideoTicks = null;
    let firstMediaVideoTicks = null;
    let firstMediaCallbackSizes = null;
    let terminalReadResult = null;
    let batches = 0;
    let writtenPackets = 0;

    while (batches++ < 100) {
        const [result, packets] = await lib.ff_read_frame_multi(fmtCtx, sourcePacket, {
            limit: engine._pumpReadBatchBytes,
        });
        const writeList = [];
        const keys = Object.keys(packets);
        keys.sort((left, right) => Number(left) === videoStream.index
            ? -1
            : (Number(right) === videoStream.index ? 1 : 0));
        for (const key of keys) {
            if (Number(key) !== videoStream.index) engine._releaseVideoDtsProbeAudio(writeList);
            for (const packet of packets[key]) {
                if (packet.stream_index === videoStream.index) {
                    const sourcePts = join64(packet.pts, packet.ptshi);
                    if (firstVideoSourcePts === null) firstVideoSourcePts = sourcePts;
                    const delta = videoTargetTicks - firstVideoSourcePts;
                    shiftTimestamp(packet, 'pts', 'ptshi', delta);
                    // Model the live file's missing/unusable source DTS so the engine
                    // reconstructs 61.907 s from the 62.563 s first key packet.
                    packet.dts = 0;
                    packet.dtshi = -2147483648;
                    packet.flags = latestVideoTicks === null ? (packet.flags | 1) : (packet.flags & ~1);
                    latestVideoTicks = join64(packet.pts, packet.ptshi);
                    packet.stream_index = engine.V_IDX;
                    for (const ready of engine._ingestVideoPacket(packet)) writeList.push(ready);
                } else if (packet.stream_index === audioStream.index && engine.vBase !== null) {
                    const sourcePts = join64(packet.pts, packet.ptshi);
                    if (firstAudioSourcePts === null) firstAudioSourcePts = sourcePts;
                    const delta = audioTargetTicks - firstAudioSourcePts;
                    shiftTimestamp(packet, 'pts', 'ptshi', delta);
                    shiftTimestamp(packet, 'dts', 'dtshi', delta);
                    packet.stream_index = engine.A_IDX;
                    engine._stageAudioForVideoDtsProbe(packet, writeList);
                }
            }
        }
        engine._releaseVideoDtsProbeAudio(writeList);
        if (writeList.length) {
            assert.strictEqual(await engine._writePacketsChecked(writeList), true);
            writtenPackets += writeList.length;
        }
        if (engine._diag.moofCount >= 1 && firstMediaVideoTicks === null) {
            firstMediaVideoTicks = latestVideoTicks;
            firstMediaCallbackSizes = Array.from(engine.queue, (chunk) => chunk.length);
            assert.strictEqual(engine._pumpReadBatchBytes, 512 * 1024,
                'the first committed media transaction must restore the production steady-state batch');
            assert.strictEqual(engine._boundedPumpBatchGeneration, null);
            assert.strictEqual(engine.timings.muxSteadyPumpReadBatchBytes, 512 * 1024);
        }
        if (result !== 0 && result !== -lib.EAGAIN) {
            terminalReadResult = result;
            break;
        }
    }

    const eofCode = typeof lib.AVERROR_EOF === 'number' ? lib.AVERROR_EOF : -541478725;
    assert.strictEqual(terminalReadResult, eofCode,
        'the fixture must reach natural demux EOF rather than stopping after its first fragment');
    assert.strictEqual(engine._tsAnchor, 62.563,
        'the real keyframe before currentTime remains the SourceBuffer origin');
    assert.ok(firstMediaVideoTicks - videoTargetTicks >= 2_000,
        'fixture must cover the two-second fragment deadline');
    const firstFragmentMediaSeconds = (firstMediaVideoTicks - videoTargetTicks)
        * videoStream.time_base_num / videoStream.time_base_den;
    assert.ok(firstFragmentMediaSeconds >= 2 && firstFragmentMediaSeconds <= 2.5,
        `first media callback must follow the 2 s cap within one frame/batch, got ${firstFragmentMediaSeconds}s`);
    const projectBitrateBps = 3_107_458;
    const projectedFragmentBytes = Math.ceil(projectBitrateBps * firstFragmentMediaSeconds / 8);
    assert.ok(projectedFragmentBytes <= 1024 * 1024,
        `Project's first bounded fragment must fit its observed 1 MiB media range, got ${projectedFragmentBytes} bytes`);
    const observedProjectSetupAndSeekMs = 10_146;
    const observedProjectMediaRangeMs = 3_667;
    const startupDeadlineMs = 15_000;
    const observedFirstMediaRangeArrivalMs = observedProjectSetupAndSeekMs + observedProjectMediaRangeMs;
    assert.strictEqual(observedFirstMediaRangeArrivalMs, 13_813);
    assert.strictEqual(startupDeadlineMs - observedFirstMediaRangeArrivalMs, 1_187,
        'the captured transport envelope must leave processing and MSE-update margin');
    assert.deepStrictEqual(firstMediaCallbackSizes, [28, 1187, 217985],
        'non-seekable AVIO must flush ftyp, moov, and the bounded media fragment in three callbacks');
    assert.ok(engine._diag.moovCount >= 1, `expected moov before trailer, saw ${engine._diag.boxSeq.join(' ')}`);
    assert.ok(engine._diag.moofCount >= 1, `expected moof before trailer, saw ${engine._diag.boxSeq.join(' ')}`);
    assert.ok(engine._diag.boxSeq.some((box) => String(box).startsWith('mdat(')),
        `expected media bytes before trailer, saw ${engine._diag.boxSeq.join(' ')}`);

    const tailVideo = engine._flushVideoPacketsAtEof();
    engine._releaseVideoDtsProbeAudio(tailVideo, true);
    if (tailVideo.length) {
        assert.strictEqual(await engine._writePacketsChecked(tailVideo), true);
        writtenPackets += tailVideo.length;
    }
    const callbacksBeforeTrailer = engine.queue.length;
    assert.strictEqual(await engine._writeTrailerChecked(), true);
    assert.ok(engine.queue.length > callbacksBeforeTrailer,
        'natural EOF must commit the final bounded media fragment, not discard it as legacy metadata');
    assert.strictEqual(engine._diag.trailerBytesDropped, 0);
    assert.ok(!engine._diag.boxSeq.some((box) => /^mfr[ao]\(/.test(String(box))),
        `skip_trailer must not emit MSE-unsafe random-access metadata: ${engine._diag.boxSeq.join(' ')}`);

    const outputBytes = engine.queue.reduce((total, chunk) => total + chunk.length, 0);
    const output = new Uint8Array(outputBytes);
    let outputOffset = 0;
    for (const chunk of engine.queue) {
        output.set(chunk, outputOffset);
        outputOffset += chunk.length;
    }
    await lib.writeFile('resume-output.mp4', output);
    const [outputContext] = await lib.ff_init_demuxer_file('resume-output.mp4');
    const outputPacket = await lib.av_packet_alloc();
    let demuxedPackets = 0;
    for (let guard = 0; guard < 1000; guard++) {
        const [result, packets] = await lib.ff_read_frame_multi(outputContext, outputPacket, { limit: 256 * 1024 });
        for (const list of Object.values(packets)) demuxedPackets += list.length;
        if (result !== 0 && result !== -lib.EAGAIN) break;
    }
    assert.strictEqual(demuxedPackets, writtenPackets,
        'every packet accepted by the bounded mux must survive natural EOF and re-demux');
});
