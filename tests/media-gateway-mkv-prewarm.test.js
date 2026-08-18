'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  MkvPrewarmError,
  PrewarmLaneCoordinator,
  derivePrewarmLaneKey,
  derivePrewarmSpoolKey,
  parseStrictContentRange,
  runMkvPrewarmAttempt,
} = require('../services/media-gateway/src/mkv-prewarm');

async function tempDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function identity(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    providerId: 'provider-a',
    itemId: 'movie-42',
    variantId: null,
    initialUrl: 'https://user:secret@provider.example/movie/source.mkv',
    profileBuild: 'h264-proof-build-1',
    ...overrides,
  };
}

function headersFor(start, end, total, etag = '"source-v1"') {
  return {
    'content-range': `bytes ${start}-${end}/${total}`,
    'content-length': String(end - start + 1),
    etag,
    'content-encoding': 'identity',
  };
}

function bodyFrom(chunks, error = null, hooks = {}) {
  return {
    cancelled: false,
    async cancel() {
      this.cancelled = true;
      if (hooks.onCancel) await hooks.onCancel();
    },
    async *[Symbol.asyncIterator]() {
      try {
        for (const chunk of chunks) {
          if (hooks.beforeChunk) await hooks.beforeChunk(chunk);
          yield chunk;
        }
        if (error) throw error;
      } finally {
        if (hooks.onFinally) hooks.onFinally();
      }
    },
  };
}

function providerResponse({ start, end, total, etag, url, chunks, error, hooks, status = 206 }) {
  return {
    status,
    url: url || 'https://cdn.provider.example/effective/source.mkv?token=private',
    headers: status === 206 ? headersFor(start, end, total, etag) : {},
    body: bodyFrom(chunks || [], error, hooks),
  };
}

function attemptOptions(spoolRoot, overrides = {}) {
  return {
    spoolRoot,
    identity: identity(),
    laneKey: derivePrewarmLaneKey('provider.example/account-a'),
    coordinator: new PrewarmLaneCoordinator(),
    maxSourceBytes: 1024 * 1024,
    onComplete: async () => ({ issued: true }),
    ...overrides,
  };
}

test('strict Content-Range parser rejects wildcards, unsafe integers, and inconsistent spans', () => {
  assert.deepEqual(parseStrictContentRange('bytes 10-19/20'), { start: 10, end: 19, total: 20, length: 10 });
  for (const invalid of [
    'bytes */20',
    'bytes 0-20/20',
    'bytes 10-9/20',
    'bytes 01-9/20',
    'items 0-9/20',
    'bytes 0-9/*',
    `bytes 0-9/${Number.MAX_SAFE_INTEGER + 1}`,
  ]) assert.equal(parseStrictContentRange(invalid), null, invalid);
});

test('a truncated attempt resumes with one new GET and proof fires only after exact EOF, fsync, and size', async (t) => {
  const spoolRoot = await tempDirectory(t, 'norva-prewarm-resume-');
  const source = Buffer.from('0123456789abcdefghij');
  const requests = [];
  let proofCalls = 0;

  const first = attemptOptions(spoolRoot, {
    openProviderGet: async (request) => {
      requests.push(request);
      return providerResponse({
        start: 0,
        end: source.length - 1,
        total: source.length,
        chunks: [source.subarray(0, 8)],
        error: new Error('socket reset'),
      });
    },
    onComplete: async () => { proofCalls += 1; },
  });
  await assert.rejects(runMkvPrewarmAttempt(first), (error) => {
    assert.equal(error.code, 'PROVIDER_STREAM_INTERRUPTED');
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].headers.Range, 'bytes=0-');
  assert.equal(requests[0].headers['If-Range'], undefined);
  assert.equal(proofCalls, 0);

  const second = attemptOptions(spoolRoot, {
    coordinator: first.coordinator,
    openProviderGet: async (request) => {
      requests.push(request);
      return providerResponse({
        start: 8,
        end: source.length - 1,
        total: source.length,
        chunks: [source.subarray(8, 13), source.subarray(13)],
      });
    },
    onComplete: async (proofInput) => {
      proofCalls += 1;
      assert.deepEqual(await fsp.readFile(proofInput.sourcePath), source);
      const entry = path.dirname(proofInput.sourcePath);
      const marker = JSON.parse(await fsp.readFile(path.join(entry, 'source.complete.json'), 'utf8'));
      assert.equal(marker.totalBytes, source.length);
      assert.equal((await fsp.stat(proofInput.sourcePath)).size, source.length);
      return { proofId: 'full-file-proof' };
    },
  });
  const completed = await runMkvPrewarmAttempt(second);
  assert.equal(completed.status, 'complete');
  assert.deepEqual(completed.proof, { proofId: 'full-file-proof' });
  assert.equal(proofCalls, 1);
  assert.equal(requests.length, 2, 'one provider GET per explicit attempt');
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].headers.Range, 'bytes=8-');
  assert.equal(requests[1].headers['If-Range'], '"source-v1"');

  let unexpectedGet = 0;
  let replayedProof = 0;
  const already = await runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
    coordinator: first.coordinator,
    openProviderGet: async () => { unexpectedGet += 1; throw new Error('must not run'); },
    onComplete: async (proofInput) => {
      replayedProof += 1;
      assert.deepEqual(await fsp.readFile(proofInput.sourcePath), source);
      return { proofId: 'replayed-local-publication' };
    },
  }));
  assert.equal(already.status, 'already-complete');
  assert.equal(unexpectedGet, 0);
  assert.equal(replayedProof, 1);
  assert.deepEqual(already.proof, { proofId: 'replayed-local-publication' });
});

test('provider lane is released at durable EOF before a slow local completion callback', async (t) => {
  const spoolRoot = await tempDirectory(t, 'norva-prewarm-local-completion-');
  const coordinator = new PrewarmLaneCoordinator();
  const laneKey = derivePrewarmLaneKey('provider.example/account-local-completion');
  let callbackEntered;
  const entered = new Promise((resolve) => { callbackEntered = resolve; });
  let releaseCallback;
  const callbackRelease = new Promise((resolve) => { releaseCallback = resolve; });

  const attempt = runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
    coordinator,
    laneKey,
    openProviderGet: async () => providerResponse({
      start: 0,
      end: 9,
      total: 10,
      chunks: [Buffer.from('0123456789')],
    }),
    onComplete: async () => {
      callbackEntered();
      await callbackRelease;
      return { published: true };
    },
  }));

  await entered;
  const viewer = await coordinator.runViewer(laneKey, async () => 'viewer-opened');
  assert.equal(viewer, 'viewer-opened', 'local publication must not retain the provider lane');
  releaseCallback();
  assert.equal((await attempt).status, 'complete');
});

test('resume fails closed when strong ETag, effective URL, or total size changes', async (t) => {
  const cases = [
    { name: 'etag', etag: '"source-v2"', url: 'https://cdn.provider.example/effective/source.mkv?token=private', total: 16 },
    { name: 'effective URL', etag: '"source-v1"', url: 'https://other-cdn.example/source.mkv', total: 16 },
    { name: 'size', etag: '"source-v1"', url: 'https://cdn.provider.example/effective/source.mkv?token=private', total: 17 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (inner) => {
      const spoolRoot = await tempDirectory(inner, `norva-prewarm-binding-${scenario.name.replace(/\W/g, '')}-`);
      const coordinator = new PrewarmLaneCoordinator();
      await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
        coordinator,
        openProviderGet: async () => providerResponse({
          start: 0,
          end: 15,
          total: 16,
          chunks: [Buffer.from('partial')],
          error: new Error('drop'),
        }),
      })), /single provider|stream ended|provider stream/i);
      let calls = 0;
      let proofCalls = 0;
      await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
        coordinator,
        openProviderGet: async () => {
          calls += 1;
          return providerResponse({
            start: 7,
            end: scenario.total - 1,
            total: scenario.total,
            etag: scenario.etag,
            url: scenario.url,
            chunks: [Buffer.alloc(scenario.total - 7)],
          });
        },
        onComplete: async () => { proofCalls += 1; },
      })), (error) => {
        assert.equal(error.code, 'RESUME_BINDING_CHANGED');
        assert.equal(error.terminal, true);
        return true;
      });
      assert.equal(calls, 1);
      assert.equal(proofCalls, 0);
    });
  }
});

test('weak validators and malformed range responses are terminal and never mint proof', async (t) => {
  const scenarios = [
    {
      name: 'weak ETag',
      response: providerResponse({ start: 0, end: 3, total: 4, etag: 'W/"weak"', chunks: [Buffer.from('data')] }),
      code: 'STRONG_ETAG_REQUIRED',
    },
    {
      name: 'wrong range start',
      response: providerResponse({ start: 1, end: 3, total: 4, chunks: [Buffer.from('ata')] }),
      code: 'INVALID_CONTENT_RANGE',
    },
    {
      name: 'encoded range',
      response: {
        ...providerResponse({ start: 0, end: 3, total: 4, chunks: [Buffer.from('data')] }),
        headers: { ...headersFor(0, 3, 4), 'content-encoding': 'gzip' },
      },
      code: 'ENCODED_PROVIDER_RANGE',
    },
    {
      name: 'non-drainable body',
      response: {
        ...providerResponse({ start: 0, end: 3, total: 4, chunks: [Buffer.from('data')] }),
        body: { async *[Symbol.asyncIterator]() { yield Buffer.from('data'); } },
      },
      code: 'PROVIDER_BODY_NOT_DRAINABLE',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (inner) => {
      const spoolRoot = await tempDirectory(inner, 'norva-prewarm-invalid-');
      let gets = 0;
      let proofs = 0;
      await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
        openProviderGet: async () => { gets += 1; return scenario.response; },
        onComplete: async () => { proofs += 1; },
      })), (error) => {
        assert.equal(error.code, scenario.code);
        assert.equal(error.terminal, true);
        return true;
      });
      assert.equal(gets, 1);
      assert.equal(proofs, 0);
    });
  }
});

test('HTTP 458 is terminal with exactly one GET and no hidden retry', async (t) => {
  const spoolRoot = await tempDirectory(t, 'norva-prewarm-458-');
  let gets = 0;
  let proofs = 0;
  const body = bodyFrom([]);
  await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
    openProviderGet: async (request) => {
      gets += 1;
      assert.equal(request.method, 'GET');
      return { status: 458, url: identity().initialUrl, headers: {}, body };
    },
    onComplete: async () => { proofs += 1; },
  })), (error) => {
    assert.equal(error.code, 'PROVIDER_BUSY');
    assert.equal(error.terminal, true);
    return true;
  });
  assert.equal(gets, 1);
  assert.equal(proofs, 0);
  assert.equal(body.cancelled, true);
});

test('network failure and truncated or oversized bodies never reconnect inside an attempt', async (t) => {
  await t.test('opener failure', async (inner) => {
    const spoolRoot = await tempDirectory(inner, 'norva-prewarm-open-fail-');
    let gets = 0;
    await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
      openProviderGet: async () => { gets += 1; throw Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }); },
    })), (error) => error.code === 'PROVIDER_GET_FAILED');
    assert.equal(gets, 1);
  });

  await t.test('declared body truncation', async (inner) => {
    const spoolRoot = await tempDirectory(inner, 'norva-prewarm-short-body-');
    let gets = 0;
    await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
      openProviderGet: async () => {
        gets += 1;
        return providerResponse({ start: 0, end: 4, total: 5, chunks: [Buffer.from('1234')] });
      },
    })), (error) => error.code === 'PROVIDER_BODY_TRUNCATED');
    assert.equal(gets, 1);
  });

  await t.test('declared body overflow', async (inner) => {
    const spoolRoot = await tempDirectory(inner, 'norva-prewarm-long-body-');
    let gets = 0;
    await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
      openProviderGet: async () => {
        gets += 1;
        return providerResponse({ start: 0, end: 3, total: 4, chunks: [Buffer.from('12345')] });
      },
    })), (error) => error.code === 'PROVIDER_BODY_TOO_LONG');
    assert.equal(gets, 1);
  });
});

test('viewer reservation aborts prewarm, waits for body drainage, and blocks a new background owner', async (t) => {
  const spoolRoot = await tempDirectory(t, 'norva-prewarm-preempt-');
  const coordinator = new PrewarmLaneCoordinator();
  const laneKey = derivePrewarmLaneKey('provider.example/account-preempt');
  let releaseBody;
  let firstChunkWritten;
  const firstChunk = new Promise((resolve) => { firstChunkWritten = resolve; });
  let bodyFinalized = false;
  const events = [];
  const openProviderGet = async ({ signal }) => providerResponse({
    start: 0,
    end: 9,
    total: 10,
    chunks: [Buffer.from('12'), Buffer.from('34567890')],
    hooks: {
      beforeChunk: async (chunk) => {
        if (chunk.length === 2) {
          firstChunkWritten();
          await new Promise((resolve) => {
            releaseBody = resolve;
            signal.addEventListener('abort', resolve, { once: true });
          });
        }
      },
      onFinally: () => { bodyFinalized = true; events.push('body-finalized'); },
    },
  });
  const prewarm = runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
    coordinator,
    laneKey,
    openProviderGet,
  }));
  await firstChunk;
  const viewer = coordinator.runViewer(laneKey, async () => {
    events.push('viewer-opened');
    assert.equal(bodyFinalized, true, 'viewer must wait for provider body drainage');
    assert.throws(() => coordinator.beginBackground(laneKey), (error) => error.code === 'PREWARM_VIEWER_ACTIVE');
    return 'viewer-ok';
  });
  if (releaseBody) releaseBody();
  assert.equal((await prewarm).status, 'preempted');
  assert.equal(await viewer, 'viewer-ok');
  assert.deepEqual(events, ['body-finalized', 'viewer-opened']);
});

test('spool paths and keys reveal no raw tenant, provider credentials, item, or URL', async (t) => {
  const spoolRoot = await tempDirectory(t, 'norva-prewarm-private-');
  const privateIdentity = identity();
  const key = derivePrewarmSpoolKey(privateIdentity);
  assert.match(key, /^[0-9a-f]{64}$/);
  for (const secret of ['tenant-a', 'provider-a', 'movie-42', 'user', 'secret']) assert.equal(key.includes(secret), false);

  await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
    openProviderGet: async () => providerResponse({ start: 0, end: 1, total: 2, chunks: [Buffer.from('x')], error: new Error('drop') }),
  })), /stream/i);
  const allNames = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      allNames.push(entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    }
  }
  await walk(spoolRoot);
  const joined = allNames.join('/');
  for (const secret of ['tenant-a', 'provider-a', 'movie-42', 'user', 'secret']) assert.equal(joined.includes(secret), false);
  const metadataFile = path.join(spoolRoot, 'entries', key.slice(0, 2), key, 'source.meta.json');
  const metadataText = await fsp.readFile(metadataFile, 'utf8');
  assert.equal(metadataText.includes(privateIdentity.initialUrl), false);
  assert.equal(metadataText.includes('user:secret'), false);
  assert.match(JSON.parse(metadataText).initialUrlHash, /^[0-9a-f]{64}$/);
  assert.equal(crypto.createHash('sha256').update(privateIdentity.initialUrl).digest('hex'), JSON.parse(metadataText).initialUrlHash);
});

test('a missing explicit coordinator fails closed before provider I/O', async (t) => {
  const spoolRoot = await tempDirectory(t, 'norva-prewarm-coordinator-');
  let gets = 0;
  await assert.rejects(runMkvPrewarmAttempt(attemptOptions(spoolRoot, {
    coordinator: null,
    openProviderGet: async () => { gets += 1; },
  })), (error) => {
    assert.equal(error.code, 'PREWARM_COORDINATOR_REQUIRED');
    return true;
  });
  assert.equal(gets, 0);
});
