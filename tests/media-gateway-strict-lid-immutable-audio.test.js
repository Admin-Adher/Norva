'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareStrictLidSpeechSample } = require('../services/media-gateway/src/strict-lid-speech-sampler');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');
const { analyzePcm16Wav } = require('../services/media-gateway/src/strict-lid-audio-evidence');
const { cleanupStrictLidFiles } = require('../services/media-gateway/src/strict-lid-batch');

function wave() {
    const samples = 60 * 16000;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) bytes.writeInt16LE(1 + Math.floor(i / 16000), 44 + i * 2);
    return bytes;
}

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-immutable-audio-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert(path.basename(directory).startsWith('norva-immutable-audio-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const wavPath = path.join(directory, 'acquisition.wav');
    const selectedWavPath = path.join(directory, 'acquisition.selected.wav');
    const bytes = wave();
    await fs.writeFile(wavPath, bytes);
    return { directory, wavPath, selectedWavPath, bytes, plan: planStrictSpeechWindow(7200, 2) };
}
const vad = { bin: '/vad', model: '/model',
    runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [{ start: 30, end: 50 }] }) };

test('selected output preserves all 60 seconds and exactly matches the existing single 20-second selection', async (t) => {
    const f = await fixture(t);
    const legacyPath = path.join(f.directory, 'legacy.wav');
    await fs.writeFile(legacyPath, f.bytes);
    const legacy = await prepareStrictLidSpeechSample({ wavPath: legacyPath, plan: f.plan, ...vad });
    const selected = await prepareStrictLidSpeechSample({ ...f, ...vad });
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.selection, legacy.selection);
    assert.deepEqual(await fs.readFile(f.selectedWavPath), await fs.readFile(legacyPath));
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
    assert.equal(analyzePcm16Wav(await fs.readFile(f.wavPath)).durationSeconds, 60);
    assert.equal(analyzePcm16Wav(await fs.readFile(f.selectedWavPath)).durationSeconds, 20);
    assert.equal(selected.offset, f.plan.searchStartSeconds + 30);
    assert(!JSON.stringify(selected).includes(f.directory));
});

test('a second local selection can inspect the retained original without fetching or concatenating audio', async (t) => {
    const f = await fixture(t);
    assert.equal((await prepareStrictLidSpeechSample({ ...f, ...vad })).ok, true);
    const alternatePath = path.join(f.directory, 'alternate.wav');
    const second = await prepareStrictLidSpeechSample({ ...f, ...vad, selectedWavPath: alternatePath,
        runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [{ start: 0, end: 20 }] }) });
    assert.equal(second.ok, true);
    const alternate = await fs.readFile(alternatePath);
    assert.equal(alternate.readInt16LE(44), 1);
    assert.equal(alternate.readInt16LE(alternate.length - 2), 20);
    assert.equal(analyzePcm16Wav(alternate).sampleCount, 320000);
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
    assert.equal(second.selection.selectedOffsetMilliseconds, f.plan.searchStartMilliseconds);
    // This is a storage/sampling test, not a second independent ASR vote.
    assert.equal(second.verified, undefined);
});

test('anchor fallback retains the original and never invents a zero-speech measurement', async (t) => {
    const f = await fixture(t);
    const result = await prepareStrictLidSpeechSample(f);
    assert.equal(result.ok, true);
    assert.equal(result.selection.selector, 'anchor-fallback');
    assert.equal(result.selection.speechMilliseconds, null);
    assert.equal(result.offset, f.plan.anchorOffsetSeconds);
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
});

test('existing destinations, aliases and hard links are never overwritten or removed', async (t) => {
    const f = await fixture(t);
    const existing = Buffer.from('existing private destination');
    await fs.writeFile(f.selectedWavPath, existing);
    assert.equal((await prepareStrictLidSpeechSample({ ...f, ...vad })).ok, false);
    assert.deepEqual(await fs.readFile(f.selectedWavPath), existing);
    assert.equal((await prepareStrictLidSpeechSample({ ...f, ...vad, selectedWavPath: f.wavPath })).ok, false);
    const hardLink = path.join(f.directory, 'hard-link.wav');
    await fs.link(f.wavPath, hardLink);
    assert.equal((await prepareStrictLidSpeechSample({ ...f, ...vad, selectedWavPath: hardLink })).ok, false);
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
    assert.deepEqual(await fs.readFile(hardLink), f.bytes);
});

test('selected output must remain in the same private directory and use an absolute path', async (t) => {
    const f = await fixture(t);
    for (const selectedWavPath of ['relative.wav', path.join(f.directory, '..', 'outside.wav'), '']) {
        const result = await prepareStrictLidSpeechSample({ ...f, selectedWavPath,
            ...vad, runVadImpl: async () => assert.fail('invalid output must be rejected before VAD') });
        assert.equal(result.ok, false);
    }
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
});

test('preemption after exclusive creation or after writing removes only the new output', async (t) => {
    for (const afterWrite of [false, true]) {
        const f = await fixture(t);
        const result = await prepareStrictLidSpeechSample({ ...f, ...vad,
            isPreempted: () => {
                if (!syncFs.existsSync(f.selectedWavPath)) return false;
                return !afterWrite || syncFs.statSync(f.selectedWavPath).size > 0;
            } });
        assert.equal(result.ok, false);
        assert.equal(result.preempted, true);
        assert.equal(syncFs.existsSync(f.selectedWavPath), false);
        assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
    }
});

test('abort during VAD creates no output and retains the complete acquisition', async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    const result = await prepareStrictLidSpeechSample({ ...f, ...vad, abortSignal: controller.signal,
        runVadImpl: async () => {
            controller.abort();
            return { ok: true, outcome: 'succeeded', segments: [{ start: 30, end: 50 }] };
        } });
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(syncFs.existsSync(f.selectedWavPath), false);
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
});

test('concurrent replacement of the source path cannot supply evidence for the original descriptor', async (t) => {
    const f = await fixture(t);
    const originalPath = path.join(f.directory, 'moved-original.wav');
    const result = await prepareStrictLidSpeechSample({ ...f, ...vad,
        runVadImpl: async () => {
            await fs.rename(f.wavPath, originalPath);
            await fs.writeFile(f.wavPath, f.bytes);
            return { ok: true, outcome: 'succeeded', segments: [{ start: 30, end: 50 }] };
        } });
    assert.equal(result.ok, false);
    assert.equal(syncFs.existsSync(f.selectedWavPath), false);
    assert.deepEqual(await fs.readFile(f.wavPath), f.bytes);
    assert.deepEqual(await fs.readFile(originalPath), f.bytes);
});

test('request cleanup can release both private files after success or a later inference failure', async (t) => {
    const f = await fixture(t);
    assert.equal((await prepareStrictLidSpeechSample({ ...f, ...vad })).ok, true);
    await cleanupStrictLidFiles([f.selectedWavPath, f.wavPath]);
    assert.equal(syncFs.existsSync(f.selectedWavPath), false);
    assert.equal(syncFs.existsSync(f.wavPath), false);
});

test('production request feeds only the selection to inference and always cleans both files', async () => {
    const source = await fs.readFile(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
    assert.match(source, /path: selectedWavPath, sourcePath: wavPath/);
    assert.match(source, /strictWavSamples\.map\(\(sample\) => sample\.path\)/);
    assert.match(source, /sample\.sourcePath \? \[sample\.path, sample\.sourcePath\] : \[sample\.path\]/);
    assert.match(source, /selectedWavPath: options\.selectedWavPath \?\? null/);
    const sampler = source.slice(source.indexOf('async function runStrictSpeechSampler('),
        source.indexOf('async function runStrictWhisperBatch('));
    assert.match(sampler, /if \(value\.ok === true && options\.selectedWavPath\)/);
    assert.match(sampler, /await cleanupStrictLidFiles\(\[options\.selectedWavPath\]\)/);
});
