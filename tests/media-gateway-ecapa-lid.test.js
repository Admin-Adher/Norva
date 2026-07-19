const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  EcapaLidWorker,
  canonicalLanguage,
  validateWavPath,
} = require('../services/media-gateway/src/ecapa-lid');

async function withWavFixture(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-ecapa-test-'));
  const wavPath = path.join(root, 'sample.wav');
  await fsp.writeFile(wavPath, Buffer.alloc(128, 0));
  try {
    return await run({ root, wavPath });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function workerResult(request, language = 'it', rawLanguage = language) {
  return {
    type: 'result',
    protocol: 1,
    id: request.id,
    ok: true,
    result: {
      candidateLanguage: language,
      rawLanguage,
      label: language === 'it' ? 'Italian' : language,
      probability: 0.91,
      logPosterior: -0.09431,
      top: [
        {
          language,
          rawLanguage,
          label: language === 'it' ? 'Italian' : language,
          probability: 0.91,
          logPosterior: -0.09431,
        },
        {
          language: 'fr',
          rawLanguage: 'fr',
          label: 'French',
          probability: 0.06,
          logPosterior: -2.81341,
        },
      ],
      margin: 2.7191,
      entropy: 0.42,
      metrics: {
        inferenceMs: 18.4,
        cpuMs: 30.2,
        rssKb: 345678,
      },
    },
  };
}

function fakeWorkerProcess({ onRequest, ready = true } = {}) {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCount = 0;
  let input = '';
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      while (input.includes('\n')) {
        const newline = input.indexOf('\n');
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (line) onRequest?.(JSON.parse(line), child);
      }
      callback();
    },
  });
  child.kill = () => {
    child.killCount += 1;
    queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    return true;
  };
  if (ready) {
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({
      type: 'ready',
      protocol: 1,
      engine: {
        family: 'speechbrain-ecapa',
        model: 'lang-id-voxlingua107-ecapa',
        revision: 'test-revision',
        speechbrain: '1.1.0',
        torch: '2.6.0+cpu',
        classes: 107,
        threads: 2,
      },
      startup: { startupMs: 800, warmupMs: 20 },
    })}\n`));
  }
  return child;
}

test('canonicalLanguage fixes the two obsolete VoxLingua labels', () => {
  assert.equal(canonicalLanguage('iw'), 'he');
  assert.equal(canonicalLanguage('jw'), 'jv');
  assert.equal(canonicalLanguage('IT'), 'it');
  assert.equal(canonicalLanguage('not-a-language'), null);
});

test('validateWavPath accepts only regular WAV files inside the allowed root', async () => {
  await withWavFixture(async ({ root, wavPath }) => {
    const accepted = await validateWavPath(wavPath, { allowedRoot: root });
    assert.equal(accepted.path, await fsp.realpath(wavPath));
    assert.equal(accepted.bytes, 128);

    const outside = path.join(path.dirname(root), 'outside.wav');
    await fsp.writeFile(outside, Buffer.alloc(128));
    try {
      await assert.rejects(
        validateWavPath(outside, { allowedRoot: root }),
        (error) => error.code === 'INVALID_WAV' && /outside/.test(error.message),
      );
    } finally {
      await fsp.rm(outside, { force: true });
    }

    const textPath = path.join(root, 'sample.txt');
    await fsp.writeFile(textPath, Buffer.alloc(128));
    await assert.rejects(
      validateWavPath(textPath, { allowedRoot: root }),
      (error) => error.code === 'INVALID_WAV' && /Only WAV/.test(error.message),
    );

    const linkPath = path.join(root, 'link.wav');
    try {
      await fsp.symlink(wavPath, linkPath, 'file');
      await assert.rejects(
        validateWavPath(linkPath, { allowedRoot: root }),
        (error) => error.code === 'INVALID_WAV' && /Symbolic-link/.test(error.message),
      );
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    }
  });
});

test('bridge keeps one worker alive and returns bounded raw benchmark evidence', async () => {
  await withWavFixture(async ({ root, wavPath }) => {
    let spawnCount = 0;
    const requests = [];
    const bridge = new EcapaLidWorker({
      allowedRoot: root,
      pythonBin: '/fake/python',
      modelDir: '/fake/model',
      startupTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      spawnImpl: () => {
        spawnCount += 1;
        return fakeWorkerProcess({
          onRequest: (request, child) => {
            requests.push(request);
            const line = `${JSON.stringify(workerResult(request))}\n`;
            child.stdout.write(line.slice(0, 31));
            child.stdout.write(line.slice(31));
          },
        });
      },
    });
    try {
      const first = await bridge.classify(wavPath);
      const second = await bridge.classify(wavPath);
      assert.equal(spawnCount, 1);
      assert.equal(requests.length, 2);
      assert.equal(first.candidateLanguage, 'it');
      assert.equal(first.probability, 0.91);
      assert.equal(first.top.length, 2);
      assert.equal(first.metrics.inferenceMs, 18.4);
      assert.equal(first.sample.wavBytes, 128);
      assert.equal(first.accepted, false);
      assert.equal(first.verified, false);
      assert.equal(JSON.stringify(first).includes(wavPath), false);
      assert.equal(second.candidateLanguage, 'it');
      assert.equal(bridge.health().ready, true);
      assert.equal(bridge.health().spawnCount, 1);
    } finally {
      bridge.close();
    }
  });
});

test('start preloads the persistent ECAPA worker before any provider WAV is touched', async () => {
  await withWavFixture(async ({ root }) => {
    let spawnCount = 0;
    const bridge = new EcapaLidWorker({
      allowedRoot: root,
      pythonBin: '/fake/python',
      modelDir: '/fake/model',
      startupTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      spawnImpl: () => {
        spawnCount += 1;
        return fakeWorkerProcess();
      },
    });
    try {
      const ready = await bridge.start();
      assert.equal(ready.engine.model, 'lang-id-voxlingua107-ecapa');
      assert.equal(bridge.health().ready, true);
      assert.equal(spawnCount, 1);
    } finally {
      bridge.close();
    }
  });
});

test('timed-out inference kills the worker and the next request restarts cleanly', async () => {
  await withWavFixture(async ({ root, wavPath }) => {
    let spawnCount = 0;
    const children = [];
    const bridge = new EcapaLidWorker({
      allowedRoot: root,
      pythonBin: '/fake/python',
      modelDir: '/fake/model',
      startupTimeoutMs: 1000,
      requestTimeoutMs: 15,
      spawnImpl: () => {
        spawnCount += 1;
        const child = fakeWorkerProcess({
          onRequest: spawnCount === 1
            ? () => {}
            : (request, process) => {
              process.stdout.write(`${JSON.stringify(workerResult(request))}\n`);
            },
        });
        children.push(child);
        return child;
      },
    });
    try {
      await assert.rejects(
        bridge.classify(wavPath),
        (error) => error.code === 'TIMEOUT' && error.retryable === true,
      );
      assert.equal(children[0].killCount, 1);

      const result = await bridge.classify(wavPath);
      assert.equal(result.candidateLanguage, 'it');
      assert.equal(spawnCount, 2);
      assert.equal(bridge.health().restartCount, 1);
    } finally {
      bridge.close();
    }
  });
});

test('oversized worker output fails closed and never leaks stderr', async () => {
  await withWavFixture(async ({ root, wavPath }) => {
    let child;
    const bridge = new EcapaLidWorker({
      allowedRoot: root,
      pythonBin: '/fake/python',
      modelDir: '/fake/model',
      maxOutputChars: 1024,
      startupTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      spawnImpl: () => {
        child = fakeWorkerProcess({
          onRequest: (_request, process) => {
            process.stderr.write(`secret-path=${wavPath}`);
            process.stdout.write('x'.repeat(2048));
          },
        });
        return child;
      },
    });
    try {
      await assert.rejects(
        bridge.classify(wavPath),
        (error) => (
          error.code === 'PROTOCOL_ERROR'
          && !error.message.includes(wavPath)
          && !error.message.includes('secret-path')
        ),
      );
      assert.equal(child.killCount, 1);
    } finally {
      bridge.close();
    }
  });
});

test('Python worker is persistent, offline, path-bounded and never marks evidence verified', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../services/media-gateway/src/ecapa_lid_worker.py'),
    'utf8',
  );
  assert.match(source, /HF_HUB_OFFLINE/);
  assert.match(source, /TRANSFORMERS_OFFLINE/);
  assert.match(source, /savedir=str\(RUNTIME_DIR\)/);
  assert.match(source, /overrides=\{"pretrained_path": str\(MODEL_DIR\)\}/);
  assert.match(source, /requested\.resolve\(strict=True\)/);
  assert.match(source, /resolved\.relative_to\(ALLOWED_ROOT\.resolve\(strict=True\)\)/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /with torch\.inference_mode\(\)/);
  assert.match(source, /engine = load_engine\(\)[\s\S]*serve\(engine\)/);
  assert.doesNotMatch(source, /verified/i);
  assert.doesNotMatch(source, /requests\.(get|post)/);
});
