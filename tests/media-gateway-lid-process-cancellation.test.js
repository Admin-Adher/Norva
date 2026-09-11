'use strict';
// Real OS child-process acceptance, with a local fixture, never a provider/model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { runWhisperDetectOnly } = require('../services/media-gateway/src/whisper-lid');

for (const method of ['full', 'detect-only']) {
  test(`${method} cancellation waits for a real process to close and rejects its output`, { timeout: 10000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-lid-cancel-'));
    const controller = new AbortController();
    let child, closed = false;
    t.after(() => { child?.kill('SIGKILL'); fs.rmSync(directory, { recursive: true, force: true }); });
    const spawnFixture = (_binary, args) => {
      const prefix = args.indexOf('-of');
      child = spawn(process.execPath, ['-e',
        "const fs=require('fs');if(process.argv[1])fs.writeFileSync(process.argv[1]+'.txt','discard this interrupted transcript');process.stderr.write('auto-detected language: en (p = 0.99)\\n');process.stdout.write('ready');setInterval(()=>{},1000);",
        prefix >= 0 ? args[prefix + 1] : ''], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('close', () => { closed = true; });
      child.stdout.once('data', () => controller.abort());
      return child;
    };
    let result, context;
    if (method === 'detect-only') {
      result = await runWhisperDetectOnly({ bin: 'fixture', model: 'fixture', wavPath: path.join(directory, 'clip.wav'),
        threads: 1, timeoutMs: 6000, spawnImpl: spawnFixture, abortSignal: controller.signal });
    } else {
      const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
      const start = source.indexOf('function runWhisperDetect(wavPath');
      const end = source.indexOf('// whisper hallucinates repetition', start);
      assert(start > 0 && end > start);
      context = vm.createContext({ spawn: spawnFixture, fsp: fs.promises, setTimeout, clearTimeout, console,
        WHISPER_BIN: 'fixture', WHISPER_MODEL: 'fixture', WHISPER_THREADS: 1, WHISPER_TIMEOUT_MS: 6000,
        whisperInferenceActive: 0, viewerPlaybackActiveLocally: () => false });
      vm.runInContext(source.slice(start, end), context);
      result = await context.runWhisperDetect(path.join(directory, 'clip.wav'), { abortSignal: controller.signal });
      assert.equal(context.whisperInferenceActive, 0);
    }
    assert.equal(closed, true, 'must not free the lane before OS child close');
    assert.equal(result.aborted, true);
    assert.equal(result.lang, null);
    assert.equal(result.prob, 0);
    assert.deepEqual(fs.readdirSync(directory), [], 'no transcript is retained');
  });
}

test('pre-aborted detection never spawns an OS process', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runWhisperDetectOnly({ abortSignal: controller.signal,
    spawnImpl: () => { throw new Error('must not spawn'); } });
  assert.equal(result.aborted, true);
});
