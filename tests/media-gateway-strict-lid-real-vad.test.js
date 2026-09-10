const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parsePcm16Wav, analyzePcm16Wav } = require('../services/media-gateway/src/strict-lid-audio-evidence');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');
const { prepareStrictLidSpeechSample } = require('../services/media-gateway/src/strict-lid-speech-sampler');

function wav(seconds) {
  const result = Buffer.alloc(44 + seconds * 32000);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(result.length - 44, 40);
  return result;
}

// Opt-in hermetic binary smoke. JFK is the public fixture shipped by the same
// pinned upstream Whisper commit, not a user/provider recording. No network here.
test('real CPU Silero chooses local speech, preserves silence fallback and rejects short PCM', {
  skip: !process.env.NORVA_STRICT_LID_REAL_VAD_FIXTURE,
}, async () => {
  const fixture = await fs.readFile(process.env.NORVA_STRICT_LID_REAL_VAD_FIXTURE);
  const parsed = parsePcm16Wav(fixture);
  assert.ok(parsed.durationSeconds > 5 && parsed.durationSeconds < 20);
  const region = wav(60);
  fixture.copy(region, 44 + 38 * 32000, parsed.dataOffset, parsed.dataOffset + parsed.dataBytes);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-vad-smoke-'));
  const speechPath = path.join(dir, 'speech.wav');
  const silencePath = path.join(dir, 'silence.wav');
  const shortPath = path.join(dir, 'short.wav');
  const options = { plan: planStrictSpeechWindow(7200, 1),
    bin: '/usr/local/bin/whisper-vad-speech-segments', model: '/opt/whisper/ggml-vad-model.bin', timeoutMs: 8000 };
  try {
    await fs.writeFile(speechPath, region);
    await fs.writeFile(silencePath, wav(60));
    await fs.writeFile(shortPath, wav(1));
    const speech = await prepareStrictLidSpeechSample({ ...options, wavPath: speechPath });
    assert.equal(speech.ok, true);
    assert.equal(speech.diagnostic.vadOutcome, 'succeeded');
    assert.equal(speech.selection.selector, 'silero-vad-max-speech-v1');
    assert.ok(speech.selection.speechMilliseconds > 5000);
    assert.notEqual(speech.selection.selectedOffsetMilliseconds, options.plan.anchorOffsetMilliseconds);
    assert.equal(analyzePcm16Wav(await fs.readFile(speechPath)).sampleCount, 320000);
    const silence = await prepareStrictLidSpeechSample({ ...options, wavPath: silencePath });
    assert.equal(silence.ok, true);
    assert.equal(silence.diagnostic.vadOutcome, 'succeeded');
    assert.equal(silence.selection.selector, 'anchor-fallback');
    assert.equal(silence.selection.speechMilliseconds, 0);
    assert.equal(silence.selection.selectedOffsetMilliseconds, options.plan.anchorOffsetMilliseconds);
    const short = await prepareStrictLidSpeechSample({ ...options, wavPath: shortPath });
    assert.equal(short.ok, false);
    assert.equal(short.diagnostic.outcome, 'invalid-audio');
    assert.equal(short.diagnostic.durationSeconds, 1);
  } finally {
    for (const file of [speechPath, silencePath, shortPath]) await fs.unlink(file).catch(() => {});
    await fs.rmdir(dir);
  }
});
