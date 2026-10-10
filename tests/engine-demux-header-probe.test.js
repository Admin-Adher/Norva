const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { window: {}, navigator: {}, performance, console, URL, AbortController,
    setTimeout, clearTimeout, queueMicrotask, TextDecoder };
sandbox.self = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/norvaEngine.js'), 'utf8'), sandbox);
const Engine = sandbox.window.NorvaEngine;
const avcc = [1, 66, 192, 12, 255, 225, 0, 4, 103, 66, 192, 12, 1, 0, 2, 104, 206];
function streams(probed = false) {
    return [
        { index: 0, codec_type: 0, codec_id: 27, time_base_num: 1, time_base_den: 1000,
            parameters: { codec_type: 0, codec_id: 27, width: 320, height: 180, sample_rate: 0, channels: 0,
                profile: probed ? 578 : -99, level: probed ? 12 : -99, extradata: Uint8Array.from(avcc) } },
        { index: 1, codec_type: 1, codec_id: 86018, time_base_num: 1, time_base_den: 1000,
            parameters: { codec_type: 1, codec_id: 86018, width: 0, height: 0, sample_rate: 48000, channels: 2,
                profile: probed ? 1 : -99, format: probed ? 8 : -1, channel_layoutmask: probed ? 3 : 0,
                extradata: Uint8Array.from([17, 144]) } },
        { index: 2, codec_type: 3, codec_id: 94225, time_base_num: 1, time_base_den: 1000,
            parameters: { codec_type: 3, codec_id: 94225, extradata: null } },
    ];
}
function engine() {
    const e = Object.create(Engine.prototype);
    e.timings = {};
    e._raCache = [{ start: 0, buf: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]) }];
    e.lib = { avcodec_get_name: async id => id === 94225 ? 'subrip' : 'unknown' };
    return e;
}
test('only self-described H264/AAC Matroska tracks qualify before and after parsing', async () => {
    const e = engine();
    assert.equal(await e._canBoundMatroskaProbe(streams()), true);
    assert.equal(await e._canBoundMatroskaProbe(streams(), true), false);
    assert.equal(await e._canBoundMatroskaProbe(streams(true), true), true);
});
for (const [name, alter] of [
    ['truncated SPS', s => { s[0].parameters.extradata = Uint8Array.from(avcc.slice(0, 10)); }],
    ['missing PPS', s => { s[0].parameters.extradata = Uint8Array.from([...avcc.slice(0, 12), 0]); }],
    ['wrong NAL type', s => { s[0].parameters.extradata[8] = 101; }],
    ['missing dimensions', s => { s[0].parameters.width = 0; }],
    ['HEVC video', s => { s[0].parameters.codec_id = 173; }],
    ['AC3 audio', s => { s[1].parameters.codec_id = 86019; }],
    ['HE-AAC configuration', s => { s[1].parameters.extradata[0] = 43; }],
    ['PCE layout', s => { s[1].parameters.extradata[1] = 128; }],
    ['mismatched rate', s => { s[1].parameters.sample_rate = 44100; }],
    ['mismatched channels', s => { s[1].parameters.channels = 6; }],
    ['unknown subtitle', s => { s[2].parameters.codec_id = 0; }],
    ['missing timebase', s => { s[2].time_base_den = 0; }],
    ['additional video', s => { s.push({ ...s[0] }); }],
    ['attachment', s => { s.push({ codec_type: 4, time_base_num: 1, time_base_den: 1000, parameters: {} }); }],
]) test(`full probing remains required for ${name}`, async () => {
    const s = streams(); alter(s);
    assert.equal(await engine()._canBoundMatroskaProbe(s), false);
});

function probeFixture({ changed = false, incomplete = false, readError = false, noneligible = false } = {}) {
    const e = engine(), calls = [], before = streams(), after = streams(true);
    if (noneligible) before[1].parameters.codec_id = 86019;
    if (changed) after[1].parameters.sample_rate = 44100;
    if (incomplete) after[1].parameters.format = -1;
    let snapshots = 0, probes = 0;
    e._readDemuxStreams = async () => { snapshots++; return snapshots === 1 ? before : snapshots === 2 ? after : streams(true); };
    Object.assign(e.lib, {
        avformat_open_input_js: async () => { calls.push('open'); return 42; },
        av_opt_set: async (_fmt, name, value) => { calls.push(`${name}=${value}`); return 0; },
        avformat_find_stream_info: async () => { probes++; calls.push('probe'); if (readError) e._lastReadError = new Error('BLOCK_HTTP_458'); return 0; },
    });
    return { e, calls, count: () => probes };
}
test('a complete bounded probe keeps all streams and releases only copied parameter snapshots', async () => {
    const { e, calls, count } = probeFixture();
    const [fmt, found] = await e._initDemuxer();
    assert.equal(fmt, 42); assert.equal(e.fmtCtx, 42);
    assert.equal(found.length, 3); assert.ok(found.every(s => !('parameters' in s)));
    assert.equal(count(), 1); assert.equal(e.timings.demuxProbeMode, 'bounded-header');
    assert.deepEqual(calls, ['open', 'probesize=65536', 'probe', 'probesize=5000000']);
});
for (const reason of ['changed', 'incomplete']) test(`${reason} codec information restores full analysis on the same context`, async () => {
    const { e, calls, count } = probeFixture({ [reason]: true });
    const [fmt, found] = await e._initDemuxer();
    assert.equal(fmt, 42); assert.equal(found.length, 3); assert.equal(count(), 2);
    assert.equal(e.timings.demuxProbeMode, 'full-fallback');
    assert.deepEqual(calls, ['open', 'probesize=65536', 'probe', 'probesize=5000000', 'probe']);
});
test('a terminal read refusal never starts a second probe', async () => {
    const { e, count } = probeFixture({ readError: true });
    await assert.rejects(e._initDemuxer(), /BLOCK_HTTP_458/);
    assert.equal(count(), 1); assert.equal(e.fmtCtx, 42);
});
test('unsupported Matroska tracks keep a single full probe with no reduced option', async () => {
    const { e, calls } = probeFixture({ noneligible: true });
    await e._initDemuxer(); assert.deepEqual(calls, ['open', 'probe']);
    assert.equal(e.timings.demuxProbeMode, 'full');
});
test('MP4 and transport-stream headers use the unchanged demux helper', async () => {
    for (const buf of [[0, 0, 0, 24], [0x47, 0x40, 0, 0]]) {
        const e = engine(); e._raCache[0].buf = Uint8Array.from(buf);
        let calls = 0;
        e.lib.ff_init_demuxer_file = async name => { calls++; assert.equal(name, 'input'); return [99, []]; };
        assert.deepEqual(await e._initDemuxer(), [99, []]); assert.equal(calls, 1);
    }
});
test('failed probe-option restoration fails closed', async () => {
    const { e, count } = probeFixture();
    e.lib.av_opt_set = async (_fmt, _name, value) => value === '5000000' ? -1 : 0;
    await assert.rejects(e._initDemuxer(), /DEMUX_PROBE_RESTORE_FAILED/);
    assert.equal(count(), 1);
});
